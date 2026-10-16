if (typeof importScripts === "function") {
  importScripts("site-policy.js", "coop.js", "constants.js", "filename.js");
} else if (typeof require === "function") {
  if (typeof globalThis.DownloadFilenameCoop === "undefined") {
    globalThis.DownloadFilenameCoop = require("./coop.js");
  }
  if (typeof globalThis.ArchReportConstants === "undefined") {
    globalThis.ArchReportConstants = require("./constants.js");
  }
  if (typeof globalThis.ArchReportFilename === "undefined") {
    globalThis.ArchReportFilename = require("./filename.js");
  }
}

const constants = globalThis.ArchReportConstants;
const filenameModule = globalThis.ArchReportFilename;
const MESSAGE_TYPE = constants.MESSAGES.DOWNLOAD_CONTEXT;
const PAGE_READY_TYPE = constants.MESSAGES.PAGE_READY;
const START_EMINWON_QUEUE_TYPE = constants.MESSAGES.START_EMINWON_QUEUE;
const EMINWON_QUEUE_DOWNLOAD_STARTED_TYPE = constants.MESSAGES.EMINWON_QUEUE_DOWNLOAD_STARTED;
const REPORT_METADATA_EXTRACTED_TYPE = constants.MESSAGES.REPORT_METADATA_EXTRACTED;
const STORAGE_KEY = constants.SETTINGS_STORAGE_KEY;
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXTS = 30;
const DOWNLOAD_STATE_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_FILENAME_LISTENER_IDLE_MS = 2 * 60 * 1000;
const ZIP_REMOVE_RETRY_DELAYS_MS = [0, 500, 2000];
const EMINWON_HOST = constants.HOSTS.EMINWON;
const EMINWON_SOURCE = constants.SOURCES.EMINWON;
const DOWNLOAD_DEBUG_PREFIX = "[archreport]";
const OWN_EXTENSION_NAME = constants.COEXISTENCE.OWN_EXTENSION_NAME;

let settingsCache = filenameModule.mergeSettings();
let pendingContexts = [];
let tabSources = {};
let zipDownloadStates = {};
let downloadFilenameListenerRegistered = false;
let settingsLoaded = false;

function hasChromeApi(path) {
  let current = typeof chrome !== "undefined" ? chrome : null;
  for (const key of path) {
    current = current && current[key];
  }
  return Boolean(current);
}

function debugWarn(message, detail) {
  if (typeof console === "undefined" || !console.warn) {
    return;
  }
  console.warn(`${DOWNLOAD_DEBUG_PREFIX} ${message}`, detail || "");
}

function consumeLastError() {
  return typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.lastError : null;
}

function downloadFilenameEvent() {
  return hasChromeApi(["downloads", "onDeterminingFilename"])
    ? chrome.downloads.onDeterminingFilename
    : null;
}

// MV3 서비스 워커는 30초만 쉬어도 내려간다. 예전에는 보고서 페이지 정보가 들어올 때만
// 파일명 리스너를 붙였다가 2분 뒤 떼었는데, 그 사이 워커가 내려가면 리스너도 정보도 사라져
// 다운로드 순간 아무도 이름을 정하지 않는 일이 생겼다. 이제 리스너는 시작할 때 한 번,
// 동기적으로 붙이고(크롬이 잠든 워커를 깨워 이벤트를 전달할 수 있도록) 다운로드마다
// 우리 몫인지 즉시 판단한다. 우리 몫이 아니면 아무것도 제안하지 않고 바로 돌려준다.
function registerDownloadFilenameListener() {
  const event = downloadFilenameEvent();
  if (!event || typeof event.addListener !== "function") {
    return false;
  }
  if (!downloadFilenameListenerRegistered &&
      (!event.hasListener || !event.hasListener(handleDownloadFilenameDetermination))) {
    event.addListener(handleDownloadFilenameDetermination);
  }
  downloadFilenameListenerRegistered = true;
  return true;
}

// 이전 버전과의 호환용 이름. 리스너는 항상 붙어 있고, 켜짐 여부만 돌려준다.
function armDownloadFilenameListener() {
  return registerDownloadFilenameListener() && settingsCache.enabled !== false;
}

function refreshDownloadFilenameListener() {
  cleanupContexts(Date.now());
  return downloadFilenameListenerRegistered && settingsCache.enabled !== false && pendingContexts.length > 0;
}

function unregisterDownloadFilenameListener() {
  const event = downloadFilenameEvent();
  if (event && typeof event.removeListener === "function" &&
      (!event.hasListener || event.hasListener(handleDownloadFilenameDetermination))) {
    event.removeListener(handleDownloadFilenameDetermination);
  }
  downloadFilenameListenerRegistered = false;
}

// ── 상태 보존 ──
// 수집한 보고서 정보와 탭 출처를 storage.session에 둔다(브라우저를 닫으면 사라지고 디스크에 남지 않는다).
const STATE_STORAGE_KEY = "archReportDownloadState";
let stateRestored = false;
let stateRestoreWaiters = [];

function stateArea() {
  if (hasChromeApi(["storage", "session", "get"])) return chrome.storage.session;
  return null;
}

function persistState() {
  const area = stateArea();
  if (!area) return;
  try {
    area.set({ [STATE_STORAGE_KEY]: { pendingContexts, tabSources } }, () => consumeLastError());
  } catch (_error) {}
}

function restoreState(callback) {
  const done = typeof callback === "function" ? callback : () => {};
  if (stateRestored) {
    done();
    return;
  }
  stateRestoreWaiters.push(done);
  if (stateRestoreWaiters.length > 1) return;
  const finish = () => {
    stateRestored = true;
    const waiters = stateRestoreWaiters;
    stateRestoreWaiters = [];
    waiters.forEach(fn => { try { fn(); } catch (_error) {} });
  };
  const area = stateArea();
  if (!area) {
    finish();
    return;
  }
  // 저장소가 응답하지 않아도 다운로드를 붙잡고 있지 않도록 상한을 둔다.
  const timer = setTimeout(finish, 1500);
  try {
    area.get(STATE_STORAGE_KEY, (result) => {
      consumeLastError();
      clearTimeout(timer);
      const stored = result && result[STATE_STORAGE_KEY];
      if (stored && !stateRestored) {
        const key = entry => JSON.stringify([entry.tabId, entry.frameId, entry.context && entry.context.downloadUrl,
          entry.context && entry.context.originalFilename, entry.context && entry.context.capturedAt]);
        const merged = new Map();
        (Array.isArray(stored.pendingContexts) ? stored.pendingContexts : []).concat(pendingContexts)
          .filter(entry => entry && entry.context)
          .forEach(entry => merged.set(key(entry), entry));
        pendingContexts = Array.from(merged.values());
        tabSources = Object.assign({}, stored.tabSources || {}, tabSources);
        cleanupContexts(Date.now());
      }
      finish();
    });
  } catch (_error) {
    clearTimeout(timer);
    finish();
  }
}

function updateActionState(settings) {
  if (!hasChromeApi(["action"])) {
    return;
  }

  const enabled = filenameModule.mergeSettings(settings).enabled !== false;
  if (chrome.action.setBadgeText) {
    chrome.action.setBadgeText({
      text: enabled ? "" : constants.ACTION.DISABLED_BADGE_TEXT
    });
  }
  if (chrome.action.setBadgeBackgroundColor) {
    chrome.action.setBadgeBackgroundColor({
      color: constants.ACTION.DISABLED_BADGE_COLOR
    });
  }
  if (chrome.action.setTitle) {
    chrome.action.setTitle({
      title: enabled ? constants.ACTION.DEFAULT_TITLE : constants.ACTION.DISABLED_TITLE
    });
  }
}

function loadSettings() {
  if (!hasChromeApi(["storage", "sync", "get"])) {
    updateActionState(settingsCache);
    return;
  }
  chrome.storage.sync.get(STORAGE_KEY, (result) => {
    settingsCache = filenameModule.mergeSettings(result && result[STORAGE_KEY]);
    settingsLoaded = true;
    updateActionState(settingsCache);
  });
}

function cleanupContexts(now) {
  pendingContexts = pendingContexts
    .filter((entry) => now - entry.context.capturedAt < CONTEXT_TTL_MS)
    .slice(-MAX_CONTEXTS);

  for (const [tabId, entry] of Object.entries(tabSources)) {
    if (!entry || now - entry.capturedAt >= CONTEXT_TTL_MS) {
      delete tabSources[tabId];
    }
  }

  for (const [downloadId, state] of Object.entries(zipDownloadStates)) {
    if (!state || now - state.createdAt >= DOWNLOAD_STATE_TTL_MS) {
      delete zipDownloadStates[downloadId];
    }
  }
}

function normalizeUrl(value) {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(String(value));
  } catch (_error) {
    return String(value);
  }
}

function hostFromUrl(url) {
  if (!url) {
    return "";
  }
  try {
    const clean = String(url).trim();
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      return "";
    }
    return new URL(clean).hostname;
  } catch (_error) {
    return "";
  }
}

function basename(value) {
  return filenameModule.filenameFromUrl(value || "");
}

function downloadValues(item) {
  return [
    item && item.filename,
    item && item.finalUrl,
    item && item.url,
    item && item.referrer,
    item && item.tabUrl
  ].map((value) => String(value || ""));
}

function isZipDownload(item) {
  return downloadValues(item).some((value) => /\.zip(?:[?#].*)?$/i.test(value)) ||
    /zip/i.test(String((item && item.mime) || ""));
}

function hasEminwonUrl(item) {
  return downloadValues(item).some((value) => value.includes(EMINWON_HOST));
}

function isRenamedByOtherExtension(item) {
  // byExtensionId/Name identify the initiator, not a filename-changing extension.
  if (item && item.byExtensionId && hasChromeApi(["runtime", "id"])) return item.byExtensionId !== chrome.runtime.id;
  const name = String((item && item.byExtensionName) || "").trim();
  return Boolean(name) && !name.includes(OWN_EXTENSION_NAME);
}

function isAcademicHostDownload(item) {
  return downloadValues(item).some(value => constants.sitePolicy.isAcademicSite(value));
}

function hasEminwonQueueContext() {
  return pendingContexts.some((entry) =>
    entry.context &&
    entry.context.source === EMINWON_SOURCE &&
    entry.context.queueBatchId
  );
}

function hasEminwonTabEvidence(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return false;
  }
  const entry = tabSources[String(tabId)];
  if (!entry) {
    return false;
  }
  if (entry.source === EMINWON_SOURCE || String(entry.pageUrl || "").includes(EMINWON_HOST)) {
    return true;
  }
  return eminwonFrameIds(tabId).length > 0;
}

function ensureTabSource(tabId) {
  const key = String(tabId);
  if (!tabSources[key]) {
    tabSources[key] = {
      source: "unknown",
      pageUrl: "",
      frames: {},
      capturedAt: Date.now()
    };
  }
  if (!tabSources[key].frames) {
    tabSources[key].frames = {};
  }
  return tabSources[key];
}

function rememberTabSource(tabId, source, pageUrl, frameId) {
  if (!Number.isInteger(tabId) || tabId < 0 || !source) {
    return;
  }

  const entry = ensureTabSource(tabId);
  const isEminwon = source === EMINWON_SOURCE || String(pageUrl || "").includes(EMINWON_HOST);
  if (isEminwon || entry.source === "unknown") {
    entry.source = isEminwon ? EMINWON_SOURCE : source;
  }
  if (pageUrl) {
    entry.pageUrl = pageUrl;
  }
  entry.capturedAt = Date.now();

  if (Number.isInteger(frameId) && frameId >= 0) {
    entry.frames[String(frameId)] = {
      source,
      pageUrl: pageUrl || "",
      capturedAt: entry.capturedAt
    };
  }
}

function tabSource(tabId) {
  cleanupContexts(Date.now());
  return tabSources[String(tabId)] || null;
}

function eminwonFrameIds(tabId) {
  const source = tabSource(tabId);
  if (!source || !source.frames) {
    return [];
  }
  return Object.entries(source.frames)
    .filter(([, frame]) =>
      frame &&
      (frame.source === EMINWON_SOURCE || String(frame.pageUrl || "").includes(EMINWON_HOST))
    )
    .map(([frameId]) => Number(frameId))
    .filter((frameId) => Number.isInteger(frameId) && frameId >= 0);
}

function isLikelyEminwonDownload(item) {
  if (hasEminwonUrl(item)) {
    return true;
  }

  const source = item && Number.isInteger(item.tabId) ? tabSource(item.tabId) : null;
  if (source && (source.source === EMINWON_SOURCE || String(source.pageUrl || "").includes(EMINWON_HOST))) {
    return true;
  }

  return pendingContexts.some((entry) =>
    entry.context &&
    entry.context.source === EMINWON_SOURCE &&
    item &&
    item.tabId >= 0 &&
    entry.tabId === item.tabId
  );
}

function zipState(downloadId) {
  const key = String(downloadId);
  if (!zipDownloadStates[key]) {
    zipDownloadStates[key] = {
      createdAt: Date.now(),
      cancelRequested: false,
      queueRequested: false,
      queueStarted: false,
      removeAttempts: 0
    };
  }
  return zipDownloadStates[key];
}

function sendQueueMessage(tabId, frameId, payload, callback) {
  const handleResponse = (response) => {
    const error = consumeLastError();
    callback(error, response, frameId);
  };

  try {
    chrome.tabs.sendMessage(
      tabId,
      payload,
      Number.isInteger(frameId) ? { frameId } : {},
      handleResponse
    );
  } catch (error) {
    callback(error, null, frameId);
  }
}

function requestEminwonQueue(downloadItem, callback) {
  const done = typeof callback === "function" ? callback : () => {};
  if (!downloadItem || downloadItem.tabId < 0 || !hasChromeApi(["tabs", "sendMessage"])) {
    done(false, { reason: "queue-message-unavailable" });
    return;
  }

  const state = zipState(downloadItem.id);
  if (state.queueStarted) {
    done(true, { reason: "queue-already-started" });
    return;
  }
  if (state.queueRequested) {
    done(false, { reason: "queue-request-already-pending" });
    return;
  }
  state.queueRequested = true;

  const payload = {
    type: START_EMINWON_QUEUE_TYPE,
    downloadId: downloadItem.id
  };
  const frameIds = Array.from(new Set(eminwonFrameIds(downloadItem.tabId)));
  const targets = frameIds.length ? frameIds : [null];
  let finished = false;
  let remaining = targets.length;
  let lastFailure = null;

  targets.forEach((frameId) => {
    sendQueueMessage(downloadItem.tabId, frameId, payload, (error, response, respondedFrameId) => {
      if (finished) {
        return;
      }
      if (error) {
        debugWarn("e-minwon queue message failed", {
          downloadId: downloadItem.id,
          frameId: respondedFrameId,
          message: error.message
        });
        lastFailure = { reason: "message-failed", message: error.message, frameId: respondedFrameId };
        remaining -= 1;
        if (remaining === 0) {
          state.queueRequested = false;
          done(false, lastFailure);
        }
        return;
      }
      if (response && response.started) {
        finished = true;
        state.queueStarted = true;
        done(true, response);
        return;
      }
      debugWarn("e-minwon queue did not start", {
        downloadId: downloadItem.id,
        frameId: respondedFrameId,
        reason: response && response.reason,
        detail: response && response.detail
      });
      lastFailure = response || { reason: "queue-not-started", frameId: respondedFrameId };
      remaining -= 1;
      if (remaining === 0) {
        state.queueRequested = false;
        done(false, lastFailure);
      }
    });
  });
}

function removeZipArtifact(downloadId) {
  if (!Number.isInteger(downloadId) || !hasChromeApi(["downloads"])) {
    return;
  }

  const state = zipState(downloadId);
  state.removeAttempts += 1;

  if (chrome.downloads.removeFile) {
    chrome.downloads.removeFile(downloadId, () => {
      consumeLastError();
    });
  }
  if (chrome.downloads.erase) {
    chrome.downloads.erase({ id: downloadId }, () => {
      consumeLastError();
    });
  }
}

function scheduleZipRemoval(downloadId) {
  if (!Number.isInteger(downloadId)) {
    return;
  }
  ZIP_REMOVE_RETRY_DELAYS_MS.forEach((delay) => {
    setTimeout(() => removeZipArtifact(downloadId), delay);
  });
}

function cancelEminwonZip(downloadItem) {
  if (!downloadItem || !Number.isInteger(downloadItem.id)) {
    return;
  }

  const state = zipState(downloadItem.id);
  requestEminwonQueue(downloadItem, (started, detail) => {
    if (!started) {
      debugWarn("leaving e-minwon ZIP download because queue did not start", {
        downloadId: downloadItem.id,
        detail
      });
      return;
    }

    if (state.cancelRequested) {
      scheduleZipRemoval(downloadItem.id);
      return;
    }

    state.cancelRequested = true;
    if (hasChromeApi(["downloads", "cancel"])) {
      chrome.downloads.cancel(downloadItem.id, () => {
        consumeLastError();
        scheduleZipRemoval(downloadItem.id);
      });
    } else {
      scheduleZipRemoval(downloadItem.id);
    }
  });
}

function maybeCancelEminwonZip(downloadItem) {
  if (!settingsCache.enabled) {
    return false;
  }
  if (!isZipDownload(downloadItem)) {
    return false;
  }
  if (!isLikelyEminwonDownload(downloadItem)) {
    return false;
  }

  cancelEminwonZip(downloadItem);
  return true;
}

function urlScore(context, item) {
  const contextUrl = normalizeUrl(context.downloadUrl);
  const itemUrl = normalizeUrl((item && (item.finalUrl || item.url)) || "");
  const itemFilename = normalizeUrl((item && item.filename) || "");
  const originalFilename = normalizeUrl(context.originalFilename || context.fileTitle || "");

  let score = 0;
  if (contextUrl && itemUrl && (itemUrl === contextUrl || itemUrl.includes(contextUrl) || contextUrl.includes(itemUrl))) {
    score += 8;
  }
  if (contextUrl && itemUrl && basename(contextUrl) && itemUrl.includes(basename(contextUrl))) {
    score += 4;
  }
  if (originalFilename && itemFilename && itemFilename.includes(originalFilename)) {
    score += 4;
  }
  if (context.fileIdx && itemUrl.includes(context.fileIdx)) {
    score += 3;
  }

  const contextHost = hostFromUrl(context.pageUrl);
  const itemHost = hostFromUrl(itemUrl);
  if (contextHost && itemHost && contextHost === itemHost) {
    score += 6;
  }

  return score;
}

function hasReportEvidence(context, item) {
  const policy = constants.sitePolicy;
  const values = [item && item.url, item && item.finalUrl, item && item.referrer, item && item.tabUrl];
  // A generic filename or stale same-tab context does not establish ownership.
  return values.some(value => policy.isReportSite(value)) ||
    [item && item.url, item && item.finalUrl].some(value => policy.sameUrl(context.downloadUrl, value));
}

function contextScore(entry, item, now) {
  if (!entry || !entry.context || !hasReportEvidence(entry.context, item)) return 0;
  let score = urlScore(entry.context, item);
  if ([item && item.referrer, item && item.tabUrl].some(value => constants.sitePolicy.isReportSite(value))) score += 6;
  if (item && item.tabId >= 0 && entry.tabId === item.tabId) {
    score += 8;
  }

  const age = now - entry.context.capturedAt;
  if (age >= 0 && age < 5000) {
    score += 3;
  } else if (age < CONTEXT_TTL_MS) {
    score += 1;
  }

  return score;
}

function chooseContextEntry(item) {
  const now = Date.now();
  cleanupContexts(now);
  const itemTabId = item && Number.isInteger(item.tabId) ? item.tabId : -1;

  const queueEntry = pendingContexts
    .filter((entry) =>
      entry.context &&
      entry.context.source === EMINWON_SOURCE &&
      entry.context.queueBatchId &&
      item &&
      (
        hasEminwonUrl(item) ||
        (itemTabId >= 0 && entry.tabId === itemTabId && hasEminwonTabEvidence(itemTabId))
      )
    )
    .sort((left, right) => {
      const leftOrder = Number(left.context.queueOrder) || 0;
      const rightOrder = Number(right.context.queueOrder) || 0;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.context.capturedAt - right.context.capturedAt;
    })[0];

  if (queueEntry) {
    pendingContexts = pendingContexts.filter((entry) => entry !== queueEntry);
    return queueEntry;
  }

  let best = null;
  for (const entry of pendingContexts) {
    if (entry.context &&
        entry.context.source === EMINWON_SOURCE &&
        entry.context.queueBatchId) {
      continue;
    }
    const score = contextScore(entry, item, now);
    if (!best || score > best.score || (score === best.score && entry.context.capturedAt > best.entry.context.capturedAt)) {
      best = { entry, score };
    }
  }

  if (!best || best.score < 4) {
    return null;
  }

  pendingContexts = pendingContexts.filter((entry) => entry !== best.entry);
  return best.entry;
}

function chooseContext(item) {
  const entry = chooseContextEntry(item);
  return entry ? entry.context : null;
}

function notifyEminwonQueueDownloadStarted(entry, downloadItem, suggestedFilename) {
  const context = entry && entry.context;
  if (!context || context.source !== EMINWON_SOURCE || !context.queueBatchId) {
    return false;
  }
  if (!hasChromeApi(["tabs", "sendMessage"]) || !Number.isInteger(entry.tabId) || entry.tabId < 0) {
    return false;
  }

  sendQueueMessage(entry.tabId, entry.frameId, {
    type: EMINWON_QUEUE_DOWNLOAD_STARTED_TYPE,
    queueBatchId: context.queueBatchId,
    queueOrder: context.queueOrder || "",
    queueTargetIndex: context.queueTargetIndex || "",
    downloadId: downloadItem && downloadItem.id,
    filename: suggestedFilename || ""
  }, () => {});
  return true;
}

function ensureReady(callback) {
  const settingsReady = (done) => {
    if (settingsLoaded || !hasChromeApi(["storage", "sync", "get"])) {
      done();
      return;
    }
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    const timer = setTimeout(finish, 1500);
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      consumeLastError();
      clearTimeout(timer);
      settingsCache = filenameModule.mergeSettings(result && result[STORAGE_KEY]);
      settingsLoaded = true;
      finish();
    });
  };
  settingsReady(() => restoreState(callback));
}

// 이 확장이 이 다운로드에 붙이고 싶은 이름을 정한다. callback({ filename, conflictAction } | undefined)
// coop.js가 다운로드마다 한 번만 부르고, 자기 리스너와 논문 확장의 문의가 결과를 함께 쓴다.
// 크롬의 DownloadItem에는 탭 ID가 없다. 다운로드를 시작한 페이지(referrer)가 어느 탭의 어느
// 프레임이었는지로 탭을 알아내 e-minwon 큐·같은 탭 판정이 실제로 동작하게 한다.
function resolveDownloadTabId(item) {
  if (!item) return -1;
  if (Number.isInteger(item.tabId) && item.tabId >= 0) return item.tabId;
  const referrer = item.referrer || "";
  if (!referrer) return -1;
  const same = constants.sitePolicy.sameUrl;
  let best = null;
  for (const [tabId, source] of Object.entries(tabSources)) {
    if (!source) continue;
    const urls = [source.pageUrl].concat(Object.values(source.frames || {}).map(frame => frame && frame.pageUrl));
    if (urls.some(url => url && same(url, referrer)) && (!best || source.capturedAt > best.at)) {
      best = { tabId: Number(tabId), at: source.capturedAt || 0 };
    }
  }
  if (!best) {
    for (const entry of pendingContexts) {
      if (entry && entry.context && Number.isInteger(entry.tabId) && entry.tabId >= 0 && same(entry.context.pageUrl, referrer) &&
          (!best || entry.context.capturedAt > best.at)) {
        best = { tabId: entry.tabId, at: entry.context.capturedAt || 0 };
      }
    }
  }
  return best ? best.tabId : -1;
}

function withResolvedTab(item) {
  if (!item || (Number.isInteger(item.tabId) && item.tabId >= 0)) return item;
  const tabId = resolveDownloadTabId(item);
  return tabId >= 0 ? Object.assign({}, item, { tabId }) : item;
}

function decideReportFilename(rawDownloadItem, callback) {
  const downloadItem = rawDownloadItem;
  let finished = false;
  const done = suggestion => {
    if (finished) return;
    finished = true;
    callback(suggestion);
  };
  // 학술 DB 다운로드는 논문 확장의 몫이다. 상태를 읽을 필요도 없이 바로 답한다.
  if (isAcademicHostDownload(downloadItem)) {
    done();
    return;
  }
  if ((settingsLoaded || !hasChromeApi(["storage", "sync", "get"])) && (stateRestored || !stateArea())) {
    stateRestored = true;
    decideDownloadFilename(withResolvedTab(downloadItem), done);
    return;
  }
  // 워커가 막 깨어났다: 설정과 저장된 보고서 정보를 읽은 뒤 판단한다.
  const watchdog = setTimeout(() => done(), 3300);
  ensureReady(() => {
    clearTimeout(watchdog);
    if (!finished) decideDownloadFilename(withResolvedTab(downloadItem), done);
  });
}

const coopBackground = globalThis.DownloadFilenameCoop.createBackground({
  role: "report",
  decide: decideReportFilename,
  sitePolicy: constants.sitePolicy
});

// downloads.onDeterminingFilename 리스너. 공존 프로토콜을 거쳐 최종 이름을 제안한다.
function handleDownloadFilenameDetermination(downloadItem, suggest) {
  return coopBackground.handleDetermining(downloadItem, suggest);
}

function decideDownloadFilename(downloadItem, safeSuggest) {
  try {
    if (!settingsCache.enabled) {
      safeSuggest();
      return;
    }

    if (maybeCancelEminwonZip(downloadItem)) {
      safeSuggest();
      return;
    }

    // 논문 파일명 확장 프로그램 등 다른 확장과의 공존:
    // 학술 DB 호스트의 다운로드는 논문 확장의 몫이므로 e-minwon 큐가 진행
    // 중이더라도 개입하지 않는다. e-minwon 호스트는 학술 패턴에 걸리지 않으므로
    // 큐 자체가 이 조건에 막히는 일은 없다.
    if (isAcademicHostDownload(downloadItem)) {
      safeSuggest();
      return;
    }
    // 다른 확장이 직접 시작한 다운로드는 큐 진행 중이 아닌 한 양보한다.
    if (!hasEminwonQueueContext() && isRenamedByOtherExtension(downloadItem)) {
      safeSuggest();
      return;
    }

    const entry = chooseContextEntry(downloadItem);
    if (!entry || !entry.context) {
      safeSuggest();
      return;
    }

    const context = entry.context;
    const filename = filenameModule.renderFilename(context, settingsCache, downloadItem);
    if (!filename) {
      debugWarn("leaving download filename unchanged because rendered filename is empty", {
        downloadId: downloadItem && downloadItem.id,
        context
      });
      safeSuggest();
      return;
    }

    safeSuggest({
      filename,
      conflictAction: "uniquify"
    });
    persistState();
    notifyEminwonQueueDownloadStarted(entry, downloadItem, filename);
  } catch (error) {
    debugWarn("leaving download filename unchanged after filename handler error", {
      downloadId: downloadItem && downloadItem.id,
      message: error && error.message
    });
    safeSuggest();
  }
}

function registerChromeListeners() {
  if (!hasChromeApi(["runtime"])) {
    return;
  }

  // 다운로드 리스너는 반드시 최상위에서 동기적으로 붙인다(잠든 워커를 깨워 전달받기 위해).
  registerDownloadFilenameListener();
  chrome.runtime.onInstalled.addListener(loadSettings);
  chrome.runtime.onStartup.addListener(loadSettings);
  loadSettings();
  restoreState();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }
    settingsCache = filenameModule.mergeSettings(changes[STORAGE_KEY].newValue);
    settingsLoaded = true;
    updateActionState(settingsCache);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === constants.MESSAGES.COOP_STATUS) {
      coopBackground.status(peers => sendResponse({ success: true, peers }));
      return true;
    }

    if (message.type === REPORT_METADATA_EXTRACTED_TYPE && sender && sender.tab) {
      const tabId = sender.tab.id;
      const metadata = message.metadata;
      if (!metadata) {
        return;
      }
      const source = metadata.url && metadata.url.includes(EMINWON_HOST)
        ? EMINWON_SOURCE
        : constants.SOURCES.UNKNOWN;
      rememberTabSource(tabId, source, metadata.url, sender.frameId);
      const key = `reportMetadata_${tabId}`;
      chrome.storage.local.get(key, (result) => {
        const existing = result[key];
        if (!existing || metadata.isTableExtract || !existing.isTableExtract) {
          chrome.storage.local.set({ [key]: metadata });
        }
      });
      return;
    }

    if (message.type === PAGE_READY_TYPE && sender && sender.tab) {
      rememberTabSource(sender.tab.id, message.source, message.pageUrl, sender.frameId);
      persistState();
      return;
    }

    if (message.type === MESSAGE_TYPE && message.context) {
      const context = filenameModule.withDerivedContext(message.context);
      context.capturedAt = context.capturedAt || Date.now();

      const tabId = sender && sender.tab ? sender.tab.id : -1;
      const frameId = sender ? sender.frameId : 0;
      rememberTabSource(tabId, context.source, context.pageUrl, frameId);

      const existingIndex = pendingContexts.findIndex((entry) =>
        entry.tabId === tabId &&
        ((context.downloadUrl && entry.context.downloadUrl === context.downloadUrl) ||
         (context.originalFilename && entry.context.originalFilename === context.originalFilename))
      );

      if (existingIndex >= 0) {
        pendingContexts[existingIndex].context = context;
      } else {
        pendingContexts.push({
          context,
          tabId,
          frameId
        });
      }
      cleanupContexts(Date.now());
      persistState();
    }
  });

  if (hasChromeApi(["runtime", "onMessageExternal"])) {
    chrome.runtime.onMessageExternal.addListener(coopBackground.handleExternal);
  }

  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });

  chrome.downloads.onCreated.addListener((downloadItem) => {
    maybeCancelEminwonZip(downloadItem);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !Number.isInteger(delta.id)) {
      return;
    }
    if (!delta.filename && !delta.mime && !delta.url && !delta.state) {
      return;
    }

    // A changed filename can be Chrome uniquifying or the user editing Save As.
    // It does not identify interference by another extension.
    chrome.downloads.search({ id: delta.id }, (items) => {
      if (chrome.runtime.lastError || !items || !items[0]) {
        return;
      }
      if (maybeCancelEminwonZip(items[0]) && delta.state) {
        scheduleZipRemoval(delta.id);
      }
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove([`reportMetadata_${tabId}`]);
    delete tabSources[String(tabId)];
    persistState();
  });

  // 다운로드 링크를 누르는 순간에도 탭은 "loading"이 된다. 그때 지우면 방금 담은 정보가
  // 사라질 수 있으므로, 실제로 다른 주소로 옮겨 갔을 때만 팝업용 페이지 정보를 비운다.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && changeInfo.url) {
      chrome.storage.local.remove([`reportMetadata_${tabId}`]);
      const source = tabSources[String(tabId)];
      if (source && source.pageUrl && !constants.sitePolicy.sameUrl(source.pageUrl, changeInfo.url) &&
          !constants.sitePolicy.isReportSite(changeInfo.url)) {
        delete tabSources[String(tabId)];
        persistState();
      }
    }
  });
}

registerChromeListeners();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    _state: {
      get pendingContexts() {
        return pendingContexts;
      },
      get tabSources() {
        return tabSources;
      },
      get zipDownloadStates() {
        return zipDownloadStates;
      },
      get downloadFilenameListenerRegistered() {
        return downloadFilenameListenerRegistered;
      },
      reset() {
        unregisterDownloadFilenameListener();
        coopBackground._reset();
        stateRestored = true;
        settingsLoaded = false;
        pendingContexts = [];
        tabSources = {};
        zipDownloadStates = {};
        settingsCache = filenameModule.mergeSettings();
      },
      setSettings(settings) {
        settingsCache = filenameModule.mergeSettings(settings);
      }
    },
    armDownloadFilenameListener,
    coopBackground,
    decideReportFilename,
    resolveDownloadTabId,
    cleanupContexts,
    chooseContext,
    chooseContextEntry,
    eminwonFrameIds,
    handleDownloadFilenameDetermination,
    hasEminwonQueueContext,
    hasEminwonTabEvidence,
    isAcademicHostDownload,
    isLikelyEminwonDownload,
    isRenamedByOtherExtension,
    isZipDownload,
    maybeCancelEminwonZip,
    notifyEminwonQueueDownloadStarted,
    rememberTabSource,
    refreshDownloadFilenameListener,
    requestEminwonQueue,
    sendQueueMessage,
    unregisterDownloadFilenameListener,
    updateActionState,
    zipState
  };
}
