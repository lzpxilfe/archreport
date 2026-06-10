(function initContentScript() {
  "use strict";

  const MESSAGE_TYPE = "arch-report-download-context";
  const extractors = globalThis.ArchReportExtractors;
  const filename = globalThis.ArchReportFilename;

  if (!extractors || !filename) {
    return;
  }

  function sourceName() {
    const host = location.hostname;
    if (host.includes("nrich.go.kr")) {
      return "nrich";
    }
    if (host.includes("e-minwon.go.kr")) {
      return "e-minwon";
    }
    if (host.includes("heritage.go.kr") || host.includes("cha.go.kr") || host.includes("khs.go.kr")) {
      return "heritage";
    }
    return "unknown";
  }

  function pageText() {
    return document.body ? document.body.innerText : "";
  }

  function buildContext(control) {
    const controlData = extractors.parseDownloadControl(control);
    if (!controlData) {
      return null;
    }

    const visibleText = pageText();
    const reportTitle = extractors.extractReportTitleFromDocument(document);
    const fileTitle = extractors.normalizeSpaces(controlData.fileTitle || controlData.originalFilename || "");

    return filename.withDerivedContext({
      source: sourceName(),
      sourceKind: controlData.sourceKind,
      pageUrl: location.href,
      pageTitle: document.title,
      reportTitle,
      year: extractors.extractYearFromText(visibleText),
      agency: extractors.extractAgencyFromText(visibleText),
      downloadUrl: controlData.downloadUrl || "",
      originalFilename: controlData.originalFilename || fileTitle,
      fileTitle,
      fileIdx: controlData.fileIdx || "",
      menuIdx: controlData.menuIdx || "",
      sequenceNumber: controlData.sequenceNumber || "",
      capturedAt: Date.now()
    });
  }

  function buildEminwonContext() {
    const detailContext = extractors.extractEminwonContextFromDocument(document);
    if (!detailContext) {
      return null;
    }

    return filename.withDerivedContext(Object.assign({}, detailContext, {
      source: "e-minwon",
      pageUrl: location.href,
      pageTitle: document.title,
      capturedAt: Date.now()
    }));
  }

  function sendContext(context) {
    if (!context || !chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPE,
      context
    }, function ignoreResponse() {
      void chrome.runtime.lastError;
    });
  }

  function captureDownloadIntent(event) {
    const control = event.target && event.target.closest
      ? event.target.closest("a, button, input[type='button'], input[type='submit']")
      : null;

    if (sourceName() === "e-minwon") {
      const eminwonContext = buildEminwonContext();
      if (eminwonContext) {
        sendContext(eminwonContext);
      }
    }

    if (!extractors.isDownloadControl(control)) {
      return;
    }

    const context = buildContext(control);
    sendContext(context);
  }

  document.addEventListener("pointerdown", captureDownloadIntent, true);
  document.addEventListener("click", captureDownloadIntent, true);
  document.addEventListener("keydown", function captureKeyboardIntent(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    captureDownloadIntent(event);
  }, true);

  if (sourceName() === "e-minwon") {
    const sendCurrentPageContext = () => {
      const context = buildEminwonContext();
      if (context) {
        sendContext(context);
      }
    };

    sendCurrentPageContext();
    window.setTimeout(sendCurrentPageContext, 1000);
    window.setTimeout(sendCurrentPageContext, 3000);
  }
})();
