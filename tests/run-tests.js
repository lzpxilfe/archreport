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

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
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
