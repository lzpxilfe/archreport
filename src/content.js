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

  function buildEminwonContexts() {
    const detailContexts = extractors.extractEminwonContextsFromDocument(document);
    if (!detailContexts || detailContexts.length === 0) {
      return [];
    }

    return detailContexts.map((ctx) =>
      filename.withDerivedContext(Object.assign({}, ctx, {
        source: "e-minwon",
        pageUrl: location.href,
        pageTitle: document.title,
        capturedAt: Date.now()
      }))
    );
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
      ? event.target.closest("a, button, input, [onclick], [data-url], [data-filename]")
      : null;

    if (sourceName() === "e-minwon") {
      const eminwonContexts = buildEminwonContexts();
      eminwonContexts.forEach((ctx) => {
        sendContext(ctx);
      });
    }

    if (!extractors.isDownloadControl(control)) {
      return;
    }

    const context = buildContext(control);
    sendContext(context);
  }

  function handleZipDownloadIntercept(event) {
    const control = event.target && event.target.closest
      ? event.target.closest("a, button, input, [onclick]")
      : null;

    if (!control) {
      return;
    }

    let combinedText = (control.textContent || "").trim() + " " +
                       (control.value || "") + " " +
                       (control.getAttribute("title") || "") + " " +
                       (control.getAttribute("alt") || "") + " " +
                       (control.getAttribute("class") || "") + " " +
                       (control.getAttribute("id") || "");

    const images = control.querySelectorAll("img");
    for (const img of images) {
      combinedText += " " + (img.getAttribute("alt") || "") + " " +
                      (img.getAttribute("title") || "") + " " +
                      (img.getAttribute("src") || "");
    }
    combinedText = extractors.normalizeSpaces(combinedText);

    const source = (control.getAttribute("href") || "") + " " + (control.getAttribute("onclick") || "");

    const isZipTrigger = 
      /일괄\s*다운|전체\s*다운|선택\s*다운|묶음\s*다운|모두\s*다운|일괄\s*내려받기|전체\s*내려받기|선택\s*내려받기|묶음\s*내려받기|모두\s*내려받기/i.test(combinedText) ||
      /zip/i.test(combinedText) && /down|다운/i.test(combinedText) ||
      /all/i.test(combinedText) && /down|다운/i.test(combinedText) ||
      /fn_getZip|ZipDownload|fileZip|zipDown|allDown|all_down|down_all|downloadAll|allDownload|allFileDown|fn_all_download|fn_download_all|fn_file_all_down/i.test(source);

    if (!isZipTrigger) {
      return;
    }

    const isSelectTrigger = /선택\s*다운|선택\s*내려받기/i.test(combinedText) || /select/i.test(combinedText);

    const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"))
      .filter((cb) => cb.id !== "checkAll" && cb.id !== "allCheck" && !cb.classList.contains("all") && !cb.classList.contains("checkAll"));

    const checkedBoxes = checkboxes.filter((cb) => cb.checked);

    let targetButtons = [];

    if (checkedBoxes.length > 0) {
      checkedBoxes.forEach((cb) => {
        const row = cb.closest("tr, li, div");
        if (!row) return;
        const btn = Array.from(row.querySelectorAll("a, button, img, input"))
          .find((el) => el !== control && extractors.isDownloadControl(el));
        if (btn) {
          targetButtons.push(btn);
        }
      });
    } else {
      if (isSelectTrigger) {
        return;
      }
      
      if (checkboxes.length > 0) {
        checkboxes.forEach((cb) => {
          const row = cb.closest("tr, li, div");
          if (!row) return;
          const btn = Array.from(row.querySelectorAll("a, button, img, input"))
            .find((el) => el !== control && extractors.isDownloadControl(el));
          if (btn) {
            targetButtons.push(btn);
          }
        });
      }

      if (targetButtons.length === 0) {
        targetButtons = Array.from(document.querySelectorAll("a, button, img, input"))
          .filter((el) => el !== control && extractors.isDownloadControl(el));
      }
    }

    targetButtons = Array.from(new Set(targetButtons));

    if (targetButtons.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    let delay = 0;
    targetButtons.forEach((btn) => {
      window.setTimeout(() => {
        btn.click();
      }, delay);
      delay += 300;
    });
  }

  document.addEventListener("click", handleZipDownloadIntercept, true);
  document.addEventListener("pointerdown", captureDownloadIntent, true);
  document.addEventListener("click", captureDownloadIntent, true);
  document.addEventListener("keydown", function captureKeyboardIntent(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    captureDownloadIntent(event);
  }, true);

  function sendAllPageContexts() {
    if (sourceName() === "e-minwon") {
      const contexts = buildEminwonContexts();
      contexts.forEach((ctx) => {
        sendContext(ctx);
      });
    } else {
      const allControls = Array.from(document.querySelectorAll("a, button, input"))
        .filter((el) => extractors.isDownloadControl(el));
      allControls.forEach((control) => {
        const context = buildContext(control);
        if (context) {
          sendContext(context);
        }
      });
    }
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

  function runPageInitialization() {
    extractAndReportMetadata();
    sendAllPageContexts();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    runPageInitialization();
  } else {
    document.addEventListener("DOMContentLoaded", runPageInitialization);
  }
  window.setTimeout(runPageInitialization, 1000);
  window.setTimeout(runPageInitialization, 3000);
})();
