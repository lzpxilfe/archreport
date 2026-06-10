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

    const tableFacts = extractors.extractTableFactsFromDocument(document);
    const visibleText = pageText();

    const reportTitle = tableFacts.reportTitle || extractors.extractReportTitleFromDocument(document);
    const year = tableFacts.year || extractors.extractYearFromText(visibleText);
    const agency = tableFacts.agency || extractors.extractAgencyFromText(visibleText);
    const fileTitle = extractors.normalizeSpaces(controlData.fileTitle || controlData.originalFilename || "");

    // Find all download controls on the page to compute dynamic sequence numbers
    const allControls = Array.from(document.querySelectorAll("a, button, input"))
      .filter((el) => extractors.isDownloadControl(el));

    let sequenceNumber = controlData.sequenceNumber || "";
    if (!sequenceNumber && allControls.length > 1) {
      const index = allControls.indexOf(control);
      if (index >= 0) {
        sequenceNumber = String(index + 1);
      }
    }

    return filename.withDerivedContext({
      source: sourceName(),
      sourceKind: controlData.sourceKind,
      pageUrl: location.href,
      pageTitle: document.title,
      reportTitle,
      year,
      agency,
      permitNumber: tableFacts.permitNumber || "",
      siteName: tableFacts.siteName || "",
      province: tableFacts.province || "",
      district: tableFacts.district || "",
      submittedDate: tableFacts.submittedDate || "",
      downloadUrl: controlData.downloadUrl || "",
      originalFilename: controlData.originalFilename || fileTitle,
      fileTitle,
      fileIdx: controlData.fileIdx || "",
      menuIdx: controlData.menuIdx || "",
      sequenceNumber,
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

  // Listen for citation requests from the extension popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "get-report-title") {
      const reportTitle = extractors.extractReportTitleFromDocument(document);
      sendResponse({ reportTitle: reportTitle || "" });
    }
  });

  function extractAndReportMetadata() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }

    const tableFacts = extractors.extractTableFactsFromDocument(document);
    const visibleText = pageText();
    const reportTitle = tableFacts.reportTitle || extractors.extractReportTitleFromDocument(document);
    const isTableExtract = Boolean(tableFacts.reportTitle);

    if (reportTitle && reportTitle.length >= 4) {
      const year = tableFacts.year || extractors.extractYearFromText(visibleText);
      const agency = tableFacts.agency || extractors.extractAgencyFromText(visibleText);

      chrome.runtime.sendMessage({
        type: "report-metadata-extracted",
        metadata: {
          reportTitle,
          year,
          agency,
          permitNumber: tableFacts.permitNumber || "",
          siteName: tableFacts.siteName || "",
          province: tableFacts.province || "",
          district: tableFacts.district || "",
          submittedDate: tableFacts.submittedDate || "",
          isTableExtract,
          url: location.href
        }
      }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    extractAndReportMetadata();
  } else {
    document.addEventListener("DOMContentLoaded", extractAndReportMetadata);
  }
  window.setTimeout(extractAndReportMetadata, 1000);
  window.setTimeout(extractAndReportMetadata, 3000);
})();
