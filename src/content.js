(function initContentScript() {
  "use strict";

  const MESSAGE_TYPE = "arch-report-download-context";
  const PAGE_READY_TYPE = "arch-report-page-ready";
  const START_EMINWON_QUEUE_TYPE = "arch-report-start-eminwon-download-queue";
  const EMINWON_QUEUE_DELAY_MS = 900;
  const EMINWON_QUEUE_CLICK_DELAY_MS = 50;
  const EMINWON_CONTROL_SELECTOR = "a, button, input, [onclick]";
  const EMINWON_FILE_CHECKBOX_HEADER_PATTERN = /\uD30C\uC77C\s*\uC774\uB984/;
  const PDF_FILENAME_PATTERN = /\.pdf\b/i;
  const DEBUG_PREFIX = "[archreport]";
  const extractors = globalThis.ArchReportExtractors;
  const filename = globalThis.ArchReportFilename;
  let eminwonDownloadQueueRunning = false;
  let eminwonQueueClickInProgress = false;

  if (!extractors || !filename) {
    return;
  }

  function debugWarn(message, detail) {
    if (typeof console === "undefined" || !console.warn) {
      return;
    }
    console.warn(`${DEBUG_PREFIX} ${message}`, detail || "");
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

  function reportPageReady() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }
    chrome.runtime.sendMessage({
      type: PAGE_READY_TYPE,
      source: sourceName(),
      pageUrl: location.href
    }, function ignoreResponse() {
      void chrome.runtime.lastError;
    });
  }

  function getClosestText(element) {
    const row = element && element.closest ? element.closest("tr, li") : null;
    if (row) {
      return extractors.normalizeSpaces(row.textContent);
    }

    let current = element && element.parentElement;
    let fallback = extractors.normalizeSpaces(element && element.textContent);
    for (let depth = 0; current && current !== document.body && depth < 4; depth += 1) {
      const text = extractors.normalizeSpaces(current.textContent);
      fallback = fallback || text;
      if (PDF_FILENAME_PATTERN.test(text) || EMINWON_FILE_CHECKBOX_HEADER_PATTERN.test(text)) {
        return text;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function isFileCheckbox(checkbox) {
    const attrs = [
      checkbox.id || "",
      checkbox.name || "",
      checkbox.className || ""
    ].join(" ").toLowerCase();
    if (/checkall|allcheck|selectall|\ball\b/.test(attrs)) {
      return false;
    }
    const rowText = getClosestText(checkbox);
    if (EMINWON_FILE_CHECKBOX_HEADER_PATTERN.test(rowText) && !PDF_FILENAME_PATTERN.test(rowText)) {
      return false;
    }
    return true;
  }

  function getEminwonFileCheckboxes(contexts) {
    const expectedCount = contexts.length;
    if (expectedCount === 0) {
      return [];
    }
    const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"))
      .filter(isFileCheckbox);
    const rowsWithPdf = checkboxes.filter((checkbox) => PDF_FILENAME_PATTERN.test(getClosestText(checkbox)));

    if (rowsWithPdf.length === expectedCount + 1) {
      return rowsWithPdf.slice(-expectedCount);
    }
    if (rowsWithPdf.length >= expectedCount) {
      return rowsWithPdf.slice(0, expectedCount);
    }
    if (checkboxes.length >= expectedCount) {
      return checkboxes.slice(-expectedCount);
    }
    return checkboxes;
  }

  function checkedFileIndexes(checkboxes) {
    return checkboxes
      .map((checkbox, index) => checkbox.checked ? index : -1)
      .filter((index) => index >= 0);
  }

  function setCheckboxChecked(checkbox, checked) {
    checkbox.checked = checked;
    checkbox.dispatchEvent(new Event("input", { bubbles: true }));
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getEminwonRegularDownloadButton(triggerControl) {
    if (extractors.classifyEminwonDownloadControl(triggerControl) === "download") {
      return triggerControl;
    }

    const controls = Array.from(document.querySelectorAll(EMINWON_CONTROL_SELECTOR));
    return controls.find((control) => extractors.classifyEminwonDownloadControl(control) === "download") || null;
  }

  function createPlanFailure(reason, detail) {
    return {
      ok: false,
      reason,
      detail: detail || {}
    };
  }

  function createPlanSuccess(plan) {
    return Object.assign({ ok: true }, plan);
  }

  function buildEminwonDownloadPlan(control, forcedTriggerKind) {
    const triggerKind = forcedTriggerKind || extractors.classifyEminwonDownloadControl(control);
    if (!triggerKind) {
      return createPlanFailure("not-download-control");
    }

    const contexts = buildEminwonContexts();
    if (contexts.length === 0) {
      return createPlanFailure("no-eminwon-contexts");
    }

    const checkboxes = getEminwonFileCheckboxes(contexts);
    if (checkboxes.length === 0) {
      return createPlanFailure("no-file-checkboxes", {
        contextCount: contexts.length
      });
    }

    const fileCount = Math.min(contexts.length, checkboxes.length);
    if (fileCount === 0) {
      return createPlanFailure("no-mapped-files", {
        contextCount: contexts.length,
        checkboxCount: checkboxes.length
      });
    }

    const targetIndexes = extractors.chooseEminwonDownloadTargetIndexes(
      fileCount,
      checkedFileIndexes(checkboxes),
      triggerKind
    );
    const downloadButton = getEminwonRegularDownloadButton(control);

    if (!downloadButton) {
      return createPlanFailure("download-button-not-found", {
        triggerKind,
        contextCount: contexts.length,
        checkboxCount: checkboxes.length
      });
    }

    return createPlanSuccess({
      contexts: contexts.slice(0, fileCount),
      checkboxes: checkboxes.slice(0, fileCount),
      downloadButton,
      targetIndexes,
      triggerKind
    });
  }

  function sendSingleEminwonContextForNativeDownload(control) {
    if (eminwonDownloadQueueRunning) {
      return;
    }

    const triggerKind = extractors.classifyEminwonDownloadControl(control);
    if (!triggerKind) {
      return;
    }

    const contexts = buildEminwonContexts();
    const checkboxes = getEminwonFileCheckboxes(contexts);
    const fileCount = Math.min(contexts.length, checkboxes.length);
    if (fileCount === 0) {
      return;
    }

    let targetIndex = -1;
    if (triggerKind === "all" && fileCount === 1) {
      targetIndex = 0;
    } else if (triggerKind === "download") {
      const selected = checkedFileIndexes(checkboxes).filter((index) => index < fileCount);
      if (selected.length === 1) {
        targetIndex = selected[0];
      }
    }

    if (targetIndex >= 0 && contexts[targetIndex]) {
      sendContext(contexts[targetIndex]);
    }
  }

  function eminwonMetadataFromContext(context) {
    if (!context || !context.reportTitle) {
      return null;
    }
    return {
      reportTitle: context.reportTitle,
      year: context.year || "",
      agency: context.agency || "",
      permitNumber: context.permitNumber || "",
      siteName: context.siteName || "",
      province: context.province || "",
      district: context.district || "",
      submittedDate: context.submittedDate || "",
      isTableExtract: true,
      url: location.href
    };
  }

  function restoreCheckboxes(checkboxes, originalStates) {
    checkboxes.forEach((checkbox, index) => {
      setCheckboxChecked(checkbox, Boolean(originalStates[index]));
    });
  }

  function stopDownloadEvent(event) {
    event.preventDefault();
    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    } else {
      event.stopPropagation();
    }
  }

  function runEminwonDownloadQueue(plan) {
    eminwonDownloadQueueRunning = true;
    const originalStates = plan.checkboxes.map((checkbox) => checkbox.checked);
    let position = 0;

    const runNext = () => {
      if (position >= plan.targetIndexes.length) {
        restoreCheckboxes(plan.checkboxes, originalStates);
        eminwonDownloadQueueRunning = false;
        return;
      }

      const targetIndex = plan.targetIndexes[position];
      plan.checkboxes.forEach((checkbox, index) => {
        setCheckboxChecked(checkbox, index === targetIndex);
      });
      sendContext(plan.contexts[targetIndex]);

      window.setTimeout(() => {
        eminwonQueueClickInProgress = true;
        try {
          plan.downloadButton.click();
        } finally {
          eminwonQueueClickInProgress = false;
        }
      }, 50);

      position += 1;
      window.setTimeout(runNext, EMINWON_QUEUE_DELAY_MS);
    };

    runNext();
  }

  function handleEminwonDownloadIntercept(event) {
    const control = event.target && event.target.closest
      ? event.target.closest(EMINWON_CONTROL_SELECTOR)
      : null;

    if (eminwonDownloadQueueRunning) {
      if (eminwonQueueClickInProgress) {
        return false;
      }
      if (extractors.classifyEminwonDownloadControl(control)) {
        stopDownloadEvent(event);
        return true;
      }
      return false;
    }

    const triggerKind = extractors.classifyEminwonDownloadControl(control);
    const plan = buildEminwonDownloadPlan(control);

    if (!plan.ok || plan.targetIndexes.length <= 1) {
      if (triggerKind === "all" && buildEminwonContexts().length > 1) {
        stopDownloadEvent(event);
        debugWarn("blocked e-minwon ZIP trigger but could not start queue", {
          reason: plan.reason,
          detail: plan.detail
        });
        return true;
      }
      return false;
    }

    stopDownloadEvent(event);
    runEminwonDownloadQueue(plan);
    return true;
  }

  function startEminwonQueueFromCurrentPage() {
    if (eminwonDownloadQueueRunning) {
      return {
        started: false,
        reason: "queue-already-running"
      };
    }

    const plan = buildEminwonDownloadPlan(null, "all");
    if (!plan.ok) {
      return {
        started: false,
        reason: plan.reason,
        detail: plan.detail
      };
    }
    if (plan.targetIndexes.length <= 1) {
      return {
        started: false,
        reason: "single-target",
        detail: {
          targetCount: plan.targetIndexes.length
        }
      };
    }

    runEminwonDownloadQueue(plan);
    return {
      started: true,
      targetCount: plan.targetIndexes.length
    };
  }

  function captureDownloadIntent(event) {
    const control = event.target && event.target.closest
      ? event.target.closest("a, button, input, [onclick], [data-url], [data-filename]")
      : null;

    if (sourceName() === "e-minwon") {
      sendSingleEminwonContextForNativeDownload(control);
      return;
    }

    if (!extractors.isDownloadControl(control)) {
      return;
    }

    const context = buildContext(control);
    sendContext(context);
  }

  function handleZipDownloadIntercept(event) {
    const control = event.target && event.target.closest
      ? event.target.closest(EMINWON_CONTROL_SELECTOR)
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

  function handleDownloadIntercept(event) {
    if (sourceName() === "e-minwon") {
      handleEminwonDownloadIntercept(event);
      return;
    }
    handleZipDownloadIntercept(event);
  }

  window.addEventListener("pointerdown", handleDownloadIntercept, true);
  window.addEventListener("mousedown", handleDownloadIntercept, true);
  window.addEventListener("click", handleDownloadIntercept, true);
  window.addEventListener("keydown", function interceptKeyboardDownload(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    handleDownloadIntercept(event);
  }, true);
  document.addEventListener("click", handleDownloadIntercept, true);
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
      if (contexts.length === 1) {
        sendContext(contexts[0]);
      }
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
    if (message && message.type === START_EMINWON_QUEUE_TYPE) {
      if (sourceName() !== "e-minwon") {
        sendResponse({
          started: false,
          reason: "not-eminwon-frame",
          detail: {
            href: location.href
          }
        });
        return;
      }
      sendResponse(startEminwonQueueFromCurrentPage());
      return;
    }

    if (message && message.type === "get-report-title") {
      if (sourceName() === "e-minwon") {
        const context = buildEminwonContexts()[0];
        sendResponse(eminwonMetadataFromContext(context) || { reportTitle: "" });
        return;
      }
      const reportTitle = extractors.extractReportTitleFromDocument(document);
      sendResponse({ reportTitle: reportTitle || "" });
    }
  });

  function extractAndReportMetadata() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }

    if (sourceName() === "e-minwon") {
      const metadata = eminwonMetadataFromContext(buildEminwonContexts()[0]);
      if (metadata) {
        chrome.runtime.sendMessage({
          type: "report-metadata-extracted",
          metadata
        }, () => {
          void chrome.runtime.lastError;
        });
      }
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
    reportPageReady();
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
