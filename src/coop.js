(function initFilenameCoop(global) {
  "use strict";

  // Keep this file identical in archreport and paper-rename-extension.
  //
  // 왜 필요한가
  // -----------
  // 크롬은 downloads.onDeterminingFilename 리스너를 가진 확장이 여럿이면 "나중에 설치된
  // 확장"의 결정을 따른다. 문제는 나중 확장이 이름을 제안하지 않아도(suggest()만 불러도,
  // 아예 부르지 않아도) 그 "제안 없음"이 이긴다는 점이다. 실제 크로미움으로 확인했다.
  //   - 논문 확장이 나중에 설치됐다면: 국가유산 보고서 이름이 전부 원래 이름으로 돌아간다.
  //   - 보고서 확장이 나중에 설치됐다면: 그 리스너가 켜져 있는 동안 논문 이름이 사라진다.
  // 그래서 두 확장은 다운로드마다 서로에게 "너라면 이 파일을 뭐라고 부르겠니"를 묻고,
  // 같은 규칙으로 최종 이름 하나를 고른 뒤 둘 다 그 이름을 제안한다. 누가 이기든 결과가 같다.
  //
  // 상대 확장은 고정된 ID로만 찾는다(웹스토어판, manifest "key"로 고정한 개발자 모드판).
  // 다른 확장이 이 프로토콜을 흉내 내 이름을 바꾸거나 다운로드 정보를 받아 가지 못하게 하기 위해서다.
  const PROTOCOL = "kr-download-filename-coop";
  const VERSION = 1;
  const KNOWN_PEERS = {
    // 웹스토어 배포판
    jmbpkgngbebnonalekniidlhomcaokef: "paper",
    pmbgfboldeeaemikpcjnbkepldchodio: "report",
    // 저장소 폴더를 "압축해제된 확장 프로그램 로드"로 올린 개발자 모드판.
    // manifest.json의 "key"로 ID가 고정된다(웹스토어 업로드 zip에서는 tools/build_zip.py가 key를 뺀다).
    gdfbjjdiahedjejclopmlfaojmdmcjin: "paper",
    oodfefldbihnlakhnnphilmcjmkfgekp: "report"
  };
  // 각 확장의 자체 결정은 3.5초 안에 끝난다(decide 쪽 상한). 상대에게 묻는 시간은 그보다 넉넉히,
  // 다운로드를 붙잡는 전체 상한은 그보다 조금 더 길게 둔다.
  const DECIDE_BUDGET_MS = 3500;
  const QUERY_TIMEOUT_MS = 5500;
  const LISTENER_DEADLINE_MS = 7000;
  const DECISION_TTL_MS = 2 * 60 * 1000;

  function hasChrome(path) {
    let current = typeof chrome !== "undefined" ? chrome : null;
    for (const key of path) current = current && current[key];
    return Boolean(current);
  }

  function lastError() {
    try { return hasChrome(["runtime"]) ? chrome.runtime.lastError : null; } catch (_error) { return null; }
  }

  function downloadSummary(item) {
    const value = item || {};
    const pick = key => (value[key] === undefined || value[key] === null ? undefined : value[key]);
    return {
      id: pick("id"),
      url: pick("url"),
      finalUrl: pick("finalUrl"),
      referrer: pick("referrer"),
      filename: pick("filename"),
      mime: pick("mime"),
      tabId: pick("tabId"),
      byExtensionId: pick("byExtensionId"),
      byExtensionName: pick("byExtensionName"),
      startTime: pick("startTime"),
      incognito: pick("incognito")
    };
  }

  function validSuggestion(suggestion) {
    if (!suggestion || typeof suggestion !== "object") return null;
    const filename = String(suggestion.filename || "");
    if (!filename || filename.length > 400 || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filename) || /^[\\/]/.test(filename) ||
        /[\x00-\x1f<>:"|?*]/.test(filename)) {
      return null;
    }
    const conflictAction = ["uniquify", "overwrite", "prompt"].includes(suggestion.conflictAction)
      ? suggestion.conflictAction
      : "uniquify";
    return { filename, conflictAction };
  }

  // 모든 참여자가 똑같이 계산하는 최종 선택 규칙.
  // 국가유산 보고서 사이트에서 시작된 다운로드는 보고서 확장의 이름이, 그 밖에는 논문 확장의
  // 이름이 우선한다. 둘 다 이름이 없으면 아무도 바꾸지 않는다.
  function chooseFinal(results, item, sitePolicy) {
    const list = (results || []).filter(Boolean).map(result => ({
      role: result.role,
      suggestion: validSuggestion(result.suggestion)
    })).filter(result => result.suggestion);
    if (!list.length) return undefined;
    const values = [item && item.url, item && item.finalUrl, item && item.referrer];
    const reportFirst = Boolean(sitePolicy && values.some(value => value && sitePolicy.isReportSite(value)));
    const order = reportFirst ? ["report", "paper"] : ["paper", "report"];
    for (const role of order) {
      const found = list.find(result => result.role === role);
      if (found) return found.suggestion;
    }
    return list[0].suggestion;
  }

  // ── 백그라운드(서비스 워커) 쪽 ──
  // decide(item, callback): 이 확장이 이 다운로드에 붙이고 싶은 이름을 callback({filename,...} | undefined)로
  // 알려준다. 같은 다운로드에 여러 번 불려도 결과가 같아야 하므로 여기서 다운로드 ID별로 기억한다.
  function createBackground(options) {
    const role = options.role;
    const decideOnce = options.decide;
    const sitePolicy = options.sitePolicy;
    const ownId = hasChrome(["runtime", "id"]) ? chrome.runtime.id : "";
    const decisions = new Map();
    // 최근에 프로토콜로 응답한 상대(팝업 표시용).
    const seen = {};

    function peerIds() {
      return Object.keys(KNOWN_PEERS).filter(id => id !== ownId && KNOWN_PEERS[id] !== role);
    }

    function sendToPeer(id, message, timeoutMs, callback) {
      if (!hasChrome(["runtime", "sendMessage"])) { callback(null); return; }
      let done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); callback(value); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        chrome.runtime.sendMessage(id, message, response => {
          // 설치되지 않았거나 꺼져 있으면 크롬이 즉시 오류로 답한다.
          if (lastError() || !response || response.protocol !== PROTOCOL) { finish(null); return; }
          seen[id] = Date.now();
          finish(response);
        });
      } catch (_error) {
        finish(null);
      }
    }

    // 다운로드 ID와 주소를 함께 열쇠로 쓴다(ID만 쓰면 다른 다운로드의 답을 미리 박아 둘 수 있다).
    function decisionKey(item) {
      if (!item || !Number.isInteger(item.id)) return null;
      return `${item.id} ${item.url || ""}`;
    }

    function decide(item, callback) {
      const key = decisionKey(item);
      const now = Date.now();
      for (const [id, entry] of decisions) {
        if (now - entry.at > DECISION_TTL_MS) decisions.delete(id);
      }
      if (key !== null && decisions.has(key)) {
        const entry = decisions.get(key);
        if (entry.done) callback(entry.value);
        else entry.waiters.push(callback);
        return;
      }
      const entry = { at: now, done: false, value: undefined, waiters: [callback] };
      if (key !== null) decisions.set(key, entry);
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        entry.done = true;
        entry.value = validSuggestion(value) || undefined;
        const waiters = entry.waiters;
        entry.waiters = [];
        waiters.forEach(fn => { try { fn(entry.value); } catch (_error) {} });
      };
      const guard = setTimeout(() => settle(undefined), DECIDE_BUDGET_MS + 300);
      try {
        decideOnce(item, value => { clearTimeout(guard); settle(value); });
      } catch (_error) {
        clearTimeout(guard);
        settle(undefined);
      }
    }

    // downloads.onDeterminingFilename 리스너. 최상위에서 동기적으로 등록해야 한다.
    function handleDetermining(item, suggest) {
      let finished = false;
      let own;
      const finish = suggestion => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        try { suggest(suggestion); } catch (_error) { lastError(); }
      };
      // 무슨 일이 있어도 다운로드를 오래 붙잡지 않는다.
      const deadline = setTimeout(() => finish(own), LISTENER_DEADLINE_MS);
      const summary = downloadSummary(item);
      const ids = peerIds();
      const results = [];
      let pending = ids.length + 1;
      const done = () => {
        pending -= 1;
        if (pending > 0) return;
        finish(chooseFinal(results, item, sitePolicy));
      };
      // 자기 결정과 상대에게 묻기를 동시에 시작한다.
      decide(item, value => {
        own = value;
        results.push({ role, suggestion: value });
        done();
      });
      ids.forEach(id => {
        sendToPeer(id, { protocol: PROTOCOL, version: VERSION, type: "decide", download: summary }, QUERY_TIMEOUT_MS, response => {
          // 역할은 상대가 주장하는 값이 아니라 우리가 아는 값으로 정한다.
          if (response && response.suggestion) results.push({ role: KNOWN_PEERS[id], suggestion: response.suggestion });
          done();
        });
      });
      return true;
    }

    function answerDecide(download, sendResponse) {
      const reply = suggestion => {
        try { sendResponse({ protocol: PROTOCOL, version: VERSION, role, suggestion: suggestion || null }); } catch (_error) {}
      };
      // 시크릿 창 다운로드는 이 확장이 시크릿에서 허용됐을 때만 답한다(일반 창 정보가 새지 않도록).
      if (download.incognito && hasChrome(["extension", "isAllowedIncognitoAccess"])) {
        try {
          chrome.extension.isAllowedIncognitoAccess(allowed => {
            lastError();
            if (!allowed) reply(null);
            else decide(download, reply);
          });
          return;
        } catch (_error) {}
      }
      decide(download, reply);
    }

    // runtime.onMessageExternal 리스너. 최상위에서 동기적으로 등록해야 한다.
    function handleExternal(message, sender, sendResponse) {
      if (!message || message.protocol !== PROTOCOL || !sender || !KNOWN_PEERS[sender.id] || sender.id === ownId) {
        return false;
      }
      seen[sender.id] = Date.now();
      if (message.type === "hello") {
        sendResponse({ protocol: PROTOCOL, version: VERSION, role });
        return false;
      }
      if (message.type === "decide" && message.download && typeof message.download === "object") {
        answerDecide(message.download, sendResponse);
        return true;
      }
      return false;
    }

    // 팝업 표시용: 상대 확장에 인사해 보고 응답한 목록을 돌려준다.
    function status(callback) {
      const ids = peerIds();
      const found = [];
      let pending = ids.length;
      if (!pending) { callback(found); return; }
      ids.forEach(id => sendToPeer(id, { protocol: PROTOCOL, version: VERSION, type: "hello", role }, 2000, response => {
        if (response) found.push({ id, role: KNOWN_PEERS[id], seenAt: seen[id] });
        pending -= 1;
        if (!pending) callback(found);
      }));
    }

    return {
      handleDetermining,
      handleExternal,
      decide,
      status,
      _reset() { decisions.clear(); }
    };
  }

  const api = {
    PROTOCOL,
    VERSION,
    KNOWN_PEERS,
    chooseFinal,
    createBackground,
    downloadSummary,
    validSuggestion
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.DownloadFilenameCoop = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
