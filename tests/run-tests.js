"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const filename = require("../src/filename.js");
global.ArchReportFilename = filename;
const extractors = require("../src/page-extractors.js");
const background = require("../src/background.js");

function fakeControl(attrs) {
  return {
    tagName: attrs.tagName || "A",
    dataset: attrs.dataset || {},
    textContent: attrs.textContent || "",
    value: attrs.value || "",
    getAttribute(name) {
      return attrs[name] || "";
    },
    closest() {
      if (!attrs.nearbyText) {
        return null;
      }
      return { textContent: attrs.nearbyText };
    }
  };
}

function fakeHeader(label, value) {
  return {
    textContent: label,
    tagName: "TH",
    parentElement: {},
    nextElementSibling: {
      tagName: "TD",
      textContent: value,
      nextElementSibling: null
    }
  };
}

function fakeDocumentForEminwon(fileNames, options) {
  const uploadedFiles = fileNames || ["울산 서하리 240-1번지 유적.pdf"];
  const opts = options || {};
  return {
    querySelectorAll(selector) {
      if (selector === "th, dt") {
        const headers = [
          fakeHeader("허가번호", opts.permitNumber || "2024-0607"),
          fakeHeader("유적명(사업명)", "울산 서하리(240-1번지) 축사 신축부지 내 유적(국비)"),
          fakeHeader("발간기관", opts.agency || "(재)한울문화유산연구원"),
          fakeHeader("제출일", opts.submittedDate || "2026-06-09"),
          fakeHeader("조사 시도", opts.province || "울산"),
          fakeHeader("조사 시군구", opts.district || "울주군")
        ];
        if (!opts.omitReportTitle) {
          headers.splice(1, 0, fakeHeader("보고서명", opts.reportTitle || "울산 서하리 240-1번지 유적"));
        }
        return headers;
      }
      if (selector === "script") {
        return [{
          textContent: uploadedFiles.map((fileName, index) =>
            `RAONKUPLOAD.AddUploadedFile('${index}', "${fileName}", "encoded-${index}", "95297915", "{}", upload1.ID);`
          ).join("\n")
        }];
      }
      if (selector === "main h1" || selector === "h1") {
        return opts.headingText ? [{ textContent: opts.headingText }] : [];
      }
      return [];
    },
    querySelector() {
      return null;
    },
    title: opts.title || ""
  };
}

function fakeChromeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      if (!listeners.includes(listener)) {
        listeners.push(listener);
      }
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    hasListener(listener) {
      return listeners.includes(listener);
    }
  };
}

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

function readJsonFromRoot(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", name), "utf8"));
}

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("default filename uses citation commas and removes duplicate attachment title", () => {
  const actual = filename.renderFilename({
    reportTitle: "정읍 고부구읍성",
    fileTitle: "정읍 고부구읍성.pdf",
    originalFilename: "정읍 고부구읍성.pdf",
    year: "2009",
    agency: "전북문화재연구원"
  }, filename.mergeSettings());

  assert.equal(actual, "전북문화재연구원, 2009, 정읍 고부구읍성.pdf");
});

test("underscore separator appears only when user template asks for it", () => {
  const settings = filename.mergeSettings({
    template: [
      { kind: "field", value: "reportTitle" },
      { kind: "separator", value: "underscore" },
      { kind: "field", value: "attachmentTitle" }
    ]
  });

  const actual = filename.renderFilename({
    reportTitle: "홍성 홍주읍성",
    attachmentTitle: "북문지",
    originalFilename: "source.pdf"
  }, settings);

  assert.equal(actual, "홍성 홍주읍성_북문지.pdf");
});

test("template reordering changes preview and output", () => {
  const settings = filename.mergeSettings({
    template: [
      { kind: "field", value: "year" },
      { kind: "separator", value: "space" },
      { kind: "field", value: "agency" },
      { kind: "separator", value: "space" },
      { kind: "field", value: "reportTitle" }
    ]
  });

  const actual = filename.renderFilename({
    reportTitle: "경주 월성 발굴조사 보고서",
    year: "2025",
    agency: "국립경주문화유산연구소",
    originalFilename: "report.pdf"
  }, settings);

  assert.equal(actual, "2025 국립경주문화유산연구소 경주 월성 발굴조사 보고서.pdf");
});

test("filename sanitizer removes Windows-forbidden characters and duplicate extension", () => {
  const actual = filename.renderFilename({
    reportTitle: "홍성 / 홍주읍성: 북문지\n유적 발굴조사보고서.pdf",
    originalFilename: "원본.pdf"
  }, filename.mergeSettings());

  assert.equal(actual, "홍성 홍주읍성 북문지 유적 발굴조사보고서.pdf");
});

test("attachment title derives meaningful volume labels", () => {
  const actual = filename.deriveAttachmentTitle(
    "경주 월성 시·발굴 조사 보고서",
    "경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf"
  );

  assert.equal(actual, "1권(시굴조사)");
});

test("heritage fixture exposes year and direct PDF download metadata", () => {
  const html = readFixture("heritage.html");
  const text = extractors.stripTags(html);
  const control = fakeControl({
    href: "javascript:fn_getDownLode('http://116.67.83.213/NEW_PDF/경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf')",
    dataset: {
      info: "1",
      url: "http://116.67.83.213/NEW_PDF/경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf",
      filename: "경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf"
    }
  });

  const parsed = extractors.parseDownloadControl(control);

  assert.equal(extractors.extractYearFromText(text), "2021");
  assert.equal(parsed.sourceKind, "heritage");
  assert.equal(parsed.sequenceNumber, "1");
  assert.equal(parsed.originalFilename, "경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf");
});

test("nrich fixture exposes agency, year, and form download metadata", () => {
  const html = readFixture("nrich.html");
  const text = extractors.stripTags(html);
  const control = fakeControl({
    onclick: "fnOriFileDownload('/kor/includeFileDownLoad.do', '714686', '1046', '');",
    textContent: "다운로드",
    nearbyText: "경주 월성 발굴조사 보고서 - C지구 가구역.pdf (50.59MB) 바로보기 다운로드"
  });

  const parsed = extractors.parseDownloadControl(control);

  assert.equal(extractors.extractYearFromText(text), "2025");
  assert.equal(extractors.extractAgencyFromText(text), "국립경주문화유산연구소");
  assert.equal(parsed.sourceKind, "nrich");
  assert.equal(parsed.fileIdx, "714686");
  assert.equal(parsed.menuIdx, "1046");
  assert.equal(parsed.fileTitle, "경주 월성 발굴조사 보고서 - C지구 가구역.pdf");
});

test("nrich preview and download controls for one PDF do not add sequence number", () => {
  const nearbyText = "경주 월성 발굴조사 보고서 - C지구 가구역.pdf (50.59MB) 바로보기 다운로드";
  const preview = extractors.parseDownloadControl(fakeControl({
    onclick: "fnFileDownload('/kor/includeFileDownLoad.do', '714686', '1046', '');",
    textContent: "바로보기",
    nearbyText
  }));
  const download = extractors.parseDownloadControl(fakeControl({
    onclick: "fnOriFileDownload('/kor/includeFileDownLoad.do', '714686', '1046', '');",
    textContent: "다운로드",
    nearbyText
  }));

  assert.equal(extractors.inferSequenceNumberForDownload(download, [preview, download]), "");
});

test("sequence number is inferred only for distinct sibling files", () => {
  const first = extractors.parseDownloadControl(fakeControl({
    onclick: "fnOriFileDownload('/kor/includeFileDownLoad.do', '714686', '1046', '');",
    textContent: "다운로드",
    nearbyText: "경주 월성 발굴조사 보고서 - C지구 가구역.pdf (50.59MB) 다운로드"
  }));
  const second = extractors.parseDownloadControl(fakeControl({
    onclick: "fnOriFileDownload('/kor/includeFileDownLoad.do', '714687', '1046', '');",
    textContent: "다운로드",
    nearbyText: "경주 월성 발굴조사 보고서 - A지구 서성벽.pdf (80.12MB) 다운로드"
  }));

  assert.equal(extractors.inferSequenceNumberForDownload(first, [first, second]), "1");
  assert.equal(extractors.inferSequenceNumberForDownload(second, [first, second]), "2");
});

test("e-minwon detail table exposes report metadata and RAON file name", () => {
  const html = readFixture("eminwon.html");
  const files = extractors.parseRaonUploadedFiles(html);
  const context = extractors.extractEminwonContextFromDocument(fakeDocumentForEminwon());
  const rendered = filename.renderFilename(context, filename.mergeSettings());

  assert.equal(files[0].fileTitle, "울산 서하리 240-1번지 유적.pdf");
  assert.equal(context.permitNumber, "2024-0607");
  assert.equal(context.reportTitle, "울산 서하리 240-1번지 유적");
  assert.equal(context.siteName, "울산 서하리(240-1번지) 축사 신축부지 내 유적(국비)");
  assert.equal(context.agency, "(재)한울문화유산연구원");
  assert.equal(context.submittedDate, "2026-06-09");
  assert.equal(context.year, "2026");
  assert.equal(context.province, "울산");
  assert.equal(context.district, "울주군");
  assert.equal(rendered, "(재)한울문화유산연구원, 2026, 울산 서하리 240-1번지 유적.pdf");
});

test("e-minwon multi-file contexts keep RAON order and add sequence numbers", () => {
  const contexts = extractors.extractEminwonContextsFromDocument(fakeDocumentForEminwon([
    "경주읍성 III 보고서-1.pdf",
    "경주읍성 III 보고서-2.pdf",
    "경주읍성 III 보고서-3.pdf"
  ]));
  const rendered = contexts.map((context) => filename.renderFilename(context, filename.mergeSettings()));

  assert.equal(contexts.length, 3);
  assert.deepEqual(contexts.map((context) => context.originalFilename), [
    "경주읍성 III 보고서-1.pdf",
    "경주읍성 III 보고서-2.pdf",
    "경주읍성 III 보고서-3.pdf"
  ]);
  assert.deepEqual(contexts.map((context) => context.sequenceNumber), ["1", "2", "3"]);
  assert.deepEqual(rendered, [
    "(재)한울문화유산연구원, 2026, 울산 서하리 240-1번지 유적 1.pdf",
    "(재)한울문화유산연구원, 2026, 울산 서하리 240-1번지 유적 2.pdf",
    "(재)한울문화유산연구원, 2026, 울산 서하리 240-1번지 유적 3.pdf"
  ]);
});

test("e-minwon derives report title from RAON file names when table has no report title", () => {
  const contexts = extractors.extractEminwonContextsFromDocument(fakeDocumentForEminwon([
    "경주읍성Ⅲ 보고서-1.pdf",
    "경주읍성Ⅲ 보고서-2.pdf",
    "경주읍성Ⅲ 보고서-3.pdf",
    "경주읍성Ⅲ 보고서-별지.pdf"
  ], {
    omitReportTitle: true,
    agency: "국가유산진흥원",
    submittedDate: "2024-01-11"
  }));
  const rendered = contexts.map((context) => filename.renderFilename(context, filename.mergeSettings()));

  assert.equal(contexts.length, 4);
  assert.equal(contexts[0].reportTitle, "경주읍성Ⅲ");
  assert.equal(contexts[0].agency, "국가유산진흥원");
  assert.equal(contexts[0].year, "2024");
  assert.deepEqual(rendered, [
    "국가유산진흥원, 2024, 경주읍성Ⅲ 1.pdf",
    "국가유산진흥원, 2024, 경주읍성Ⅲ 2.pdf",
    "국가유산진흥원, 2024, 경주읍성Ⅲ 3.pdf",
    "국가유산진흥원, 2024, 경주읍성Ⅲ 4.pdf"
  ]);
});

test("report title fallback rejects e-minwon search filter text", () => {
  const title = extractors.extractReportTitleFromDocument(fakeDocumentForEminwon([], {
    omitReportTitle: true,
    headingText: "조사시도 시도 서울 부산 대구 인천 광주 대전 울산 세종 경기 강원 충북 충남 전북 전남 경북 경남 제주 시군구 제출년도 2026 2025 2024 2023 2022 2021 2020"
  }));

  assert.equal(title, "");
});

test("report title fallback rejects generic CHA report list heading", () => {
  const title = extractors.extractReportTitleFromDocument(fakeDocumentForEminwon([], {
    omitReportTitle: true,
    headingText: "발굴조사 보고서"
  }));

  assert.equal(title, "");
});

test("report title fallback rejects CHA layout section heading", () => {
  const title = extractors.extractReportTitleFromDocument(fakeDocumentForEminwon([], {
    omitReportTitle: true,
    headingText: "행정정보"
  }));

  assert.equal(title, "");
});

test("agency extractor rejects CHA shell explanatory text", () => {
  const text = "발굴조사 보고서는 각 발간기관에서 국가유산 협업포털(e-minwon.go.kr)에 직접입력 후, 자동 연계 공개되는 시스템입니다. 궁금하신 사항이 있을 경우, 각 발간기관으로 문의하시기 바랍니다.";

  assert.equal(extractors.extractAgencyFromText(text), "");
});

test("e-minwon bulk target planner intercepts only multi-file downloads", () => {
  assert.equal(extractors.classifyEminwonDownloadControl(fakeControl({ value: "전체 다운로드" })), "all");
  assert.equal(extractors.classifyEminwonDownloadControl(fakeControl({ value: "다운로드" })), "download");
  assert.deepEqual(extractors.chooseEminwonDownloadTargetIndexes(4, [0, 2], "all"), [0, 1, 2, 3]);
  assert.deepEqual(extractors.chooseEminwonDownloadTargetIndexes(4, [0, 2], "download"), [0, 2]);
  assert.deepEqual(extractors.chooseEminwonDownloadTargetIndexes(4, [2], "download"), []);
  assert.deepEqual(extractors.chooseEminwonDownloadTargetIndexes(1, [0], "all"), []);
});

test("background identifies e-minwon ZIP downloads from remembered frames", () => {
  background._state.reset();
  background.rememberTabSource(7, "e-minwon", "https://www.e-minwon.go.kr/example", 3);

  assert.equal(background.isZipDownload({ filename: "download.zip" }), true);
  assert.deepEqual(background.eminwonFrameIds(7), [3]);
  assert.equal(background.isLikelyEminwonDownload({
    id: 11,
    tabId: 7,
    filename: "download.zip"
  }), true);
});

test("background cleanup prunes stale ZIP states", () => {
  background._state.reset();
  background.zipState(9);
  assert.equal(Boolean(background._state.zipDownloadStates["9"]), true);

  background.cleanupContexts(Date.now() + 11 * 60 * 1000);

  assert.equal(Boolean(background._state.zipDownloadStates["9"]), false);
});

test("background sends e-minwon queue messages with an options object", () => {
  const calls = [];
  global.chrome = {
    runtime: {
      lastError: null
    },
    tabs: {
      sendMessage(...args) {
        calls.push(args);
        args[3]({ started: true });
      }
    }
  };

  background.sendQueueMessage(3, null, { type: "x" }, (error, response) => {
    assert.equal(error, null);
    assert.deepEqual(response, { started: true });
  });

  background.sendQueueMessage(3, 7, { type: "x" }, (error, response, frameId) => {
    assert.equal(error, null);
    assert.deepEqual(response, { started: true });
    assert.equal(frameId, 7);
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), [3, { type: "x" }, {}]);
  assert.deepEqual(calls[1].slice(0, 3), [3, { type: "x" }, { frameId: 7 }]);
  delete global.chrome;
});

test("background notifies e-minwon queue frame when a queued download starts", () => {
  const calls = [];
  global.chrome = {
    runtime: {
      lastError: null
    },
    tabs: {
      sendMessage(...args) {
        calls.push(args);
        args[3]({ received: true });
      }
    }
  };

  const notified = background.notifyEminwonQueueDownloadStarted({
    tabId: 9,
    frameId: 4,
    context: {
      source: "e-minwon",
      queueBatchId: "batch-3",
      queueOrder: "2",
      queueTargetIndex: "1"
    }
  }, {
    id: 77
  }, "renamed.pdf");

  assert.equal(notified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 9);
  assert.deepEqual(calls[0][1], {
    type: "arch-report-eminwon-queue-download-started",
    queueBatchId: "batch-3",
    queueOrder: "2",
    queueTargetIndex: "1",
    downloadId: 77,
    filename: "renamed.pdf"
  });
  assert.deepEqual(calls[0][2], { frameId: 4 });
  delete global.chrome;
});

test("background cancels e-minwon ZIP only after queue starts", () => {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    let cancelCount = 0;
    global.chrome = {
      runtime: {
        lastError: null
      },
      tabs: {
        sendMessage(_tabId, _payload, _options, callback) {
          callback({ started: false, reason: "no-plan" });
        }
      },
      downloads: {
        cancel(_downloadId, callback) {
          cancelCount += 1;
          callback();
        },
        removeFile(_downloadId, callback) {
          callback();
        },
        erase(_query, callback) {
          callback();
        }
      }
    };

    background._state.reset();
    background.rememberTabSource(3, "e-minwon", "https://www.e-minwon.go.kr/example", 0);
    background.maybeCancelEminwonZip({ id: 21, tabId: 3, filename: "download.zip" });
    assert.equal(cancelCount, 0);

    global.chrome.tabs.sendMessage = (_tabId, _payload, _options, callback) => {
      callback({ started: true });
    };
    background._state.reset();
    background.rememberTabSource(3, "e-minwon", "https://www.e-minwon.go.kr/example", 0);
    background.maybeCancelEminwonZip({ id: 22, tabId: 3, filename: "download.zip" });
    assert.equal(cancelCount, 1);
  } finally {
    console.warn = originalWarn;
    delete global.chrome;
  }
});

test("background leaves e-minwon ZIP untouched while extension is disabled", () => {
  let messageCount = 0;
  global.chrome = {
    runtime: {
      lastError: null
    },
    tabs: {
      sendMessage(_tabId, _payload, _options, callback) {
        messageCount += 1;
        callback({ started: true });
      }
    },
    downloads: {
      cancel(_downloadId, callback) {
        callback();
      },
      removeFile(_downloadId, callback) {
        callback();
      },
      erase(_query, callback) {
        callback();
      }
    }
  };

  try {
    background._state.reset();
    background._state.setSettings({ enabled: false });
    background.rememberTabSource(3, "e-minwon", "https://www.e-minwon.go.kr/example", 0);

    assert.equal(background.maybeCancelEminwonZip({ id: 31, tabId: 3, filename: "download.zip" }), false);
    assert.equal(messageCount, 0);
  } finally {
    delete global.chrome;
  }
});

test("background does not keep a global filename listener without context", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();

    assert.equal(background.refreshDownloadFilenameListener(), false);
    assert.equal(filenameEvent.listeners.length, 0);
    assert.equal(background._state.downloadFilenameListenerRegistered, false);
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});

test("background arms filename listener for pending context only", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    runtime: {
      lastError: null
    },
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();
    background._state.pendingContexts.push({
      tabId: 12,
      frameId: 0,
      context: {
        source: "heritage",
        reportTitle: "Report",
        year: "2026",
        agency: "Agency",
        originalFilename: "source.pdf",
        downloadUrl: "https://example.test/source.pdf",
        pageUrl: "https://www.heritage.go.kr/example",
        capturedAt: Date.now()
      }
    });

    assert.equal(background.armDownloadFilenameListener(), true);
    assert.equal(filenameEvent.listeners.length, 1);
    assert.equal(background._state.downloadFilenameListenerRegistered, true);

    let suggestion;
    filenameEvent.listeners[0]({
      id: 101,
      tabId: 12,
      filename: "source.pdf",
      url: "https://example.test/source.pdf"
    }, (value) => {
      suggestion = value;
    });

    assert.deepEqual(suggestion, {
      filename: "Agency, 2026, Report.pdf",
      conflictAction: "uniquify"
    });
    assert.equal(background._state.pendingContexts.length, 0);
    assert.equal(filenameEvent.listeners.length, 0);
    assert.equal(background._state.downloadFilenameListenerRegistered, false);
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});

test("background does not arm filename listener while disabled", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();
    background._state.setSettings({ enabled: false });
    background._state.pendingContexts.push({
      tabId: 3,
      frameId: 0,
      context: {
        reportTitle: "Report",
        originalFilename: "source.pdf",
        capturedAt: Date.now()
      }
    });

    assert.equal(background.armDownloadFilenameListener(), false);
    assert.equal(filenameEvent.listeners.length, 0);
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});

test("manifest and package versions stay aligned", () => {
  const manifest = readJsonFromRoot("manifest.json");
  const packageJson = readJsonFromRoot("package.json");

  assert.equal(manifest.version, "0.1.3");
  assert.equal(packageJson.version, manifest.version);
});

test("package metadata and LICENSE use GPL-2.0-only", () => {
  const packageJson = readJsonFromRoot("package.json");
  const licenseText = fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8");

  assert.equal(packageJson.license, "GPL-2.0-only");
  assert.match(licenseText, /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/);
});

test("background updates toolbar badge for enabled state", () => {
  const badgeTexts = [];
  const titles = [];
  global.chrome = {
    action: {
      setBadgeText(details) {
        badgeTexts.push(details.text);
      },
      setBadgeBackgroundColor() {},
      setTitle(details) {
        titles.push(details.title);
      }
    }
  };

  try {
    background.updateActionState({ enabled: false });
    background.updateActionState({ enabled: true });

    assert.deepEqual(badgeTexts, ["OFF", ""]);
    assert.match(titles[0], /꺼짐/);
    assert.ok(!/꺼짐/.test(titles[1]));
  } finally {
    delete global.chrome;
  }
});

test("background consumes e-minwon queue contexts in queue order", () => {
  background._state.reset();
  const now = Date.now();
  background.rememberTabSource(5, "e-minwon", "https://www.e-minwon.go.kr/example", 0);
  background._state.pendingContexts.push(
    {
      tabId: 5,
      frameId: 0,
      context: {
        source: "e-minwon",
        reportTitle: "테스트",
        queueBatchId: "batch-1",
        queueOrder: "2",
        sequenceNumber: "2",
        capturedAt: now
      }
    },
    {
      tabId: 5,
      frameId: 0,
      context: {
        source: "e-minwon",
        reportTitle: "테스트",
        queueBatchId: "batch-1",
        queueOrder: "1",
        sequenceNumber: "1",
        capturedAt: now + 100
      }
    }
  );

  const first = background.chooseContext({ tabId: 5, filename: "download.pdf" });
  const second = background.chooseContext({ tabId: 5, filename: "download.pdf" });

  assert.equal(first.sequenceNumber, "1");
  assert.equal(second.sequenceNumber, "2");
});

test("background consumes e-minwon queue context for tabless e-minwon downloads", () => {
  background._state.reset();
  background._state.pendingContexts.push({
    tabId: 5,
    frameId: 0,
    context: {
      source: "e-minwon",
      reportTitle: "테스트",
      queueBatchId: "batch-2",
      queueOrder: "1",
      sequenceNumber: "1",
      pageUrl: "https://www.e-minwon.go.kr/example",
      capturedAt: Date.now()
    }
  });

  const context = background.chooseContext({
    tabId: -1,
    url: "https://www.e-minwon.go.kr/download/file.pdf",
    filename: "download.pdf"
  });

  assert.equal(context.sequenceNumber, "1");
});

test("relaxed text download controls are detected only on supported archive hosts", () => {
  const cihcControl = fakeControl({ textContent: "선택된 자료 다운로드" });
  const parsed = extractors.relaxedDownloadControlForHost(cihcControl, "www.cihc.or.kr");
  assert.equal(parsed.sourceKind, "cihc");
  assert.equal(parsed.agency, "충남역사문화연구원");

  const digitalControl = fakeControl({ textContent: "파일 다운로드" });
  const digital = extractors.relaxedDownloadControlForHost(digitalControl, "digital.khs.go.kr");
  assert.equal(digital.sourceKind, "digital-heritage");

  const ihaChapter = fakeControl({
    textContent: "1. 표지",
    href: "javascript:getDownloadDataFile('96456');"
  });
  const ihaParsed = extractors.relaxedDownloadControlForHost(ihaChapter, "www.iha.go.kr");
  assert.equal(ihaParsed.sourceKind, "iha");

  const ihaMain = fakeControl({ textContent: "다운로드" });
  assert.equal(
    extractors.relaxedDownloadControlForHost(ihaMain, "www.iha.go.kr").sourceKind,
    "iha"
  );

  assert.equal(extractors.relaxedDownloadControlForHost(cihcControl, "www.heritage.go.kr"), null);
  assert.equal(
    extractors.relaxedDownloadControlForHost(fakeControl({ textContent: "마이 Box 담기" }), "digital.khs.go.kr"),
    null
  );
  assert.equal(
    extractors.relaxedDownloadControlForHost(fakeControl({ textContent: "1. 표지" }), "www.iha.go.kr"),
    null
  );
});

test("iha infos list exposes agency and production year", () => {
  const doc = {
    querySelectorAll(selector) {
      if (selector === "th, dt") {
        return [];
      }
      if (selector === ".infos li") {
        return [
          {
            querySelector(name) {
              if (name === "strong") return { textContent: "생산기관" };
              if (name === "p") return { textContent: "국립무형유산원" };
              return null;
            }
          },
          {
            querySelector(name) {
              if (name === "strong") return { textContent: "생산년도" };
              if (name === "p") return { textContent: "2012" };
              return null;
            }
          }
        ];
      }
      return [];
    }
  };

  const facts = extractors.extractTableFactsFromDocument(doc);
  assert.equal(facts.agency, "국립무형유산원");
  assert.equal(facts.year, "2012");
});

test("iha strong.tt wins as report title", () => {
  const doc = {
    querySelectorAll(selector) {
      if (selector === "strong.tt") {
        return [{ textContent: "무형문화유산 자원조사 연구(무형문화유산 연구총서 3)" }];
      }
      if (selector === "h1") {
        return [{ textContent: "무형유산지식새김" }];
      }
      return [];
    },
    querySelector() {
      return null;
    },
    title: ""
  };

  assert.equal(
    extractors.extractReportTitleFromDocument(doc),
    "무형문화유산 자원조사 연구(무형문화유산 연구총서 3)"
  );
});

test("cihc info-title wins over site logo h1 as report title", () => {
  const doc = {
    querySelectorAll(selector) {
      if (selector === ".info-title") {
        return [{ textContent: "조선왕실 가봉태실 근현대 학술자료집" }];
      }
      if (selector === "h1") {
        return [{ textContent: "충남역사문화연구원" }];
      }
      return [];
    },
    querySelector() {
      return null;
    },
    title: ""
  };

  assert.equal(extractors.extractReportTitleFromDocument(doc), "조선왕실 가봉태실 근현대 학술자료집");
});

test("cihc detail table derives year from generated date", () => {
  const doc = {
    querySelectorAll(selector) {
      return selector === "th, dt" ? [fakeHeader("촬영(생성)일자", "2025-12-31")] : [];
    }
  };

  const facts = extractors.extractTableFactsFromDocument(doc);
  assert.equal(facts.submittedDate, "2025-12-31");
  assert.equal(facts.year, "2025");
});

test("background consumes e-minwon queue context when download item omits tabId", () => {
  background._state.reset();
  background._state.pendingContexts.push({
    tabId: 5,
    frameId: 0,
    context: {
      source: "e-minwon",
      reportTitle: "test",
      queueBatchId: "batch-3",
      queueOrder: "1",
      sequenceNumber: "1",
      pageUrl: "https://www.e-minwon.go.kr/example",
      capturedAt: Date.now()
    }
  });

  const context = background.chooseContext({
    url: "https://www.e-minwon.go.kr/kuploadProxy.do?k00=x",
    filename: "download.pdf"
  });

  assert.equal(context.sequenceNumber, "1");
});

test("background ignores e-minwon queue context for unrelated same-tab downloads", () => {
  background._state.reset();
  background._state.pendingContexts.push({
    tabId: 5,
    frameId: 0,
    context: {
      source: "e-minwon",
      reportTitle: "테스트",
      queueBatchId: "batch-4",
      queueOrder: "1",
      sequenceNumber: "1",
      pageUrl: "https://www.e-minwon.go.kr/example",
      capturedAt: Date.now()
    }
  });

  const context = background.chooseContext({
    tabId: 5,
    url: "https://example.test/unrelated.pdf",
    filename: "download.pdf"
  });

  assert.equal(context, null);
  assert.equal(background._state.pendingContexts.length, 1);
});

test("background defers to another extension's renamed download", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();
    background._state.pendingContexts.push({
      tabId: 12,
      frameId: 0,
      context: {
        source: "heritage",
        reportTitle: "Report",
        year: "2026",
        agency: "Agency",
        originalFilename: "source.pdf",
        downloadUrl: "https://example.test/source.pdf",
        pageUrl: "https://www.heritage.go.kr/example",
        capturedAt: Date.now()
      }
    });
    background.armDownloadFilenameListener();

    let suggestion;
    filenameEvent.listeners[0]({
      id: 201,
      tabId: 12,
      filename: "Kim, 2025, Some Paper Title.pdf",
      url: "https://example.test/source.pdf",
      byExtensionName: "논문 PDF 인용식 파일명"
    }, (value) => {
      suggestion = value;
    });

    assert.equal(suggestion, undefined);
    assert.equal(background._state.pendingContexts.length, 1);
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});

test("background defers on academic hosts even for same-tab contexts", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();
    background._state.pendingContexts.push({
      tabId: 13,
      frameId: 0,
      context: {
        source: "heritage",
        reportTitle: "Report",
        year: "2026",
        agency: "Agency",
        originalFilename: "source.pdf",
        downloadUrl: "https://www.heritage.go.kr/source.pdf",
        pageUrl: "https://www.heritage.go.kr/example",
        capturedAt: Date.now()
      }
    });
    background.armDownloadFilenameListener();

    let suggestion;
    filenameEvent.listeners[0]({
      id: 202,
      tabId: 13,
      filename: "paper.pdf",
      url: "https://www.kci.go.kr/kciportal/ci/sereApp/download.pdf",
      finalUrl: "https://www.kci.go.kr/kciportal/ci/sereApp/download.pdf"
    }, (value) => {
      suggestion = value;
    });

    assert.equal(suggestion, undefined);
    assert.equal(background._state.pendingContexts.length, 1);
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});

test("background renames e-minwon queue downloads even when another extension renamed", () => {
  const filenameEvent = fakeChromeEvent();
  global.chrome = {
    downloads: {
      onDeterminingFilename: filenameEvent
    }
  };

  try {
    background._state.reset();
    background._state.pendingContexts.push({
      tabId: 5,
      frameId: 0,
      context: {
        source: "e-minwon",
        reportTitle: "테스트",
        year: "2026",
        agency: "기관",
        queueBatchId: "batch-5",
        queueOrder: "1",
        sequenceNumber: "1",
        originalFilename: "source.pdf",
        downloadUrl: "https://www.e-minwon.go.kr/kuploadProxy.do?file=source.pdf",
        pageUrl: "https://www.e-minwon.go.kr/example",
        capturedAt: Date.now()
      }
    });
    background.armDownloadFilenameListener();

    let suggestion;
    filenameEvent.listeners[0]({
      id: 203,
      tabId: 5,
      filename: "paper.pdf",
      url: "https://www.e-minwon.go.kr/kuploadProxy.do?file=source.pdf",
      byExtensionName: "논문 PDF 인용식 파일명"
    }, (value) => {
      suggestion = value;
    });

    assert.deepEqual(suggestion, {
      filename: "기관, 2026, 테스트 1.pdf",
      conflictAction: "uniquify"
    });
  } finally {
    background._state.reset();
    delete global.chrome;
  }
});
