(function initContentScript() {
  "use strict";

  const MESSAGE_TYPE = "arch-report-download-context";
  const PAGE_READY_TYPE = "arch-report-page-ready";
  const START_EMINWON_QUEUE_TYPE = "arch-report-start-eminwon-download-queue";
  const EMINWON_CONTEXT_BRIDGE_TYPE = "arch-report-eminwon-context-bridge";
  const EMINWON_CONTEXT_REQUEST_TYPE = "arch-report-eminwon-context-request";
  const EMINWON_QUEUE_BRIDGE_TYPE = "arch-report-eminwon-download-queue-bridge";
  const EMINWON_QUEUE_DOWNLOAD_STARTED_TYPE = "arch-report-eminwon-queue-download-started";
  const STORAGE_KEY = "archReportSettings";
  const EMINWON_QUEUE_ACK_TIMEOUT_MS = 10000;
  const EMINWON_QUEUE_AFTER_ACK_DELAY_MS = 350;
  const EMINWON_QUEUE_CLICK_DELAY_MS = 120;
  const EMINWON_CONTROL_SELECTOR = "a, button, input, [onclick]";
  const EMINWON_FILE_CHECKBOX_HEADER_PATTERN = /\uD30C\uC77C\s*\uC774\uB984/;
  const EMINWON_CHILD_INTERCEPT_MARK = "__archReportEminwonChildInterceptInstalled";
  const PDF_FILENAME_PATTERN = /\.pdf\b/i;
  const DEBUG_PREFIX = "[archreport]";
  const extractors = globalThis.ArchReportExtractors;
  const filename = globalThis.ArchReportFilename;
  let eminwonDownloadQueueRunning = false;
  let eminwonQueueClickInProgress = false;
  let eminwonQueueWaiter = null;
  let bridgedEminwonContexts = [];
  let extensionEnabled = true;

  if (!extractors || !filename) {
    return;
  }

  function debugWarn(message, detail) {
    if (typeof console === "undefined" || !console.warn) {
      return;
    }
    let suffix = "";
    if (detail) {
      try {
        suffix = `: ${JSON.stringify(detail)}`;
      } catch (_error) {
        suffix = `: ${String(detail)}`;
      }
    }
    console.warn(`${DEBUG_PREFIX} ${message}${suffix}`);
  }

  function hasChromeApi(path) {
    let current = typeof chrome !== "undefined" ? chrome : null;
    for (const key of path) {
      current = current && current[key];
    }
    return Boolean(current);
  }

  function applyStoredSettings(stored) {
    extensionEnabled = filename.mergeSettings(stored).enabled !== false;
  }

  function loadExtensionSettings(callback) {
    const done = typeof callback === "function" ? callback : () => {};
    if (!hasChromeApi(["storage", "sync", "get"])) {
      done();
      return;
    }
    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      applyStoredSettings(result && result[STORAGE_KEY]);
      done();
    });
  }

  function observeExtensionSettings() {
    if (!hasChromeApi(["storage", "onChanged", "addListener"])) {
      return;
    }
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes[STORAGE_KEY]) {
        return;
      }
      const wasEnabled = extensionEnabled;
      applyStoredSettings(changes[STORAGE_KEY].newValue);
      if (!wasEnabled && extensionEnabled) {
        window.setTimeout(runPageInitialization, 0);
      }
    });
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

  function hasRaonUploadControls(doc) {
    const root = doc || document;
    return Boolean(
      root.getElementById("button_download") ||
      root.getElementById("button_download_all") ||
      root.querySelector("input[id^='chk_file_']") ||
      root.querySelector("iframe[id^='raonkuploader_frame_']")
    );
  }

  function isEminwonContextFrame() {
    return sourceName() === "e-minwon" ||
      bridgedEminwonContexts.length > 0 ||
      hasRaonUploadControls(document);
  }

  function clonePlain(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return null;
    }
  }

  function normalizeEminwonContext(context) {
    if (!context || typeof context !== "object") {
      return null;
    }
    return filename.withDerivedContext(Object.assign({}, context, {
      source: "e-minwon",
      pageUrl: context.pageUrl || location.href,
      pageTitle: context.pageTitle || document.title,
      capturedAt: Date.now()
    }));
  }

  function storeBridgedEminwonContexts(contexts) {
    if (!Array.isArray(contexts) || contexts.length === 0) {
      return false;
    }
    const normalized = contexts
      .map(normalizeEminwonContext)
      .filter(Boolean);
    if (normalized.length === 0) {
      return false;
    }
    bridgedEminwonContexts = normalized;
    reportPageReady();
    return true;
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
    let detailContexts = extractors.extractEminwonContextsFromDocument(document);
    if ((!detailContexts || detailContexts.length === 0) && bridgedEminwonContexts.length > 0) {
      detailContexts = bridgedEminwonContexts;
    }
    if (!detailContexts || detailContexts.length === 0) {
      detailContexts = buildEminwonContextsFromVisibleRows();
    }
    if (!detailContexts || detailContexts.length === 0) {
      return [];
    }

    return detailContexts
      .map(normalizeEminwonContext)
      .filter(Boolean);
  }

  function extractPdfFilenameFromText(text) {
    const normalized = extractors.normalizeSpaces(text);
    const match = normalized.match(/([^\\/:*?"<>|\r\n]+?\.pdf)\b/i);
    return extractors.normalizeSpaces((match && match[1]) || "");
  }

  function buildEminwonContextsFromVisibleRows() {
    const facts = extractors.extractTableFactsFromDocument(document);
    const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox']"))
      .filter(isFileCheckbox);
    const files = [];

    checkboxes.forEach((checkbox) => {
      const fileTitle = extractPdfFilenameFromText(getClosestText(checkbox));
      if (fileTitle && !files.some((file) => file.fileTitle === fileTitle)) {
        files.push({ fileTitle });
      }
    });

    if (files.length === 0) {
      return [];
    }

    const reportTitle = facts.reportTitle || extractors.deriveReportTitleFromUploadedFiles(files);
    if (!reportTitle) {
      return [];
    }

    return files.map((file, index) => Object.assign({}, facts, {
      reportTitle,
      sourceKind: "e-minwon",
      fileTitle: file.fileTitle,
      originalFilename: file.fileTitle,
      attachmentTitle: "",
      sequenceNumber: files.length > 1 ? String(index + 1) : ""
    }));
  }

  function sendContext(context) {
    if (!extensionEnabled || !context || !chrome.runtime || !chrome.runtime.sendMessage) {
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
    if (!extensionEnabled || !chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }
    chrome.runtime.sendMessage({
      type: PAGE_READY_TYPE,
      source: isEminwonContextFrame() ? "e-minwon" : sourceName(),
      pageUrl: bridgedEminwonContexts[0] && bridgedEminwonContexts[0].pageUrl || location.href
    }, function ignoreResponse() {
      void chrome.runtime.lastError;
    });
  }

  function childFrames() {
    return Array.from(document.querySelectorAll("iframe, frame"))
      .filter((frame) => frame && frame.contentWindow);
  }

  function accessibleChildDocuments() {
    return childFrames()
      .map((frame) => {
        try {
          return frame.contentDocument || frame.contentWindow.document;
        } catch (_error) {
          return null;
        }
      })
      .filter((doc) => doc && doc !== document);
  }

  function broadcastEminwonContextsToChildFrames() {
    if (!extensionEnabled || sourceName() !== "e-minwon") {
      return 0;
    }
    const contexts = buildEminwonContexts();
    if (contexts.length === 0) {
      return 0;
    }
    const message = {
      type: EMINWON_CONTEXT_BRIDGE_TYPE,
      contexts: clonePlain(contexts) || contexts
    };
    const frames = childFrames();
    frames.forEach((frame) => {
      frame.contentWindow.postMessage(message, "*");
    });
    return frames.length;
  }

  function requestEminwonContextsFromParent() {
    if (!extensionEnabled || sourceName() === "e-minwon" || !window.parent || window.parent === window) {
      return;
    }
    window.parent.postMessage({
      type: EMINWON_CONTEXT_REQUEST_TYPE
    }, "*");
  }

  function getClosestText(element) {
    const row = element && element.closest ? element.closest("tr, li") : null;
    if (row) {
      return extractors.normalizeSpaces(row.textContent);
    }

    const ownerDoc = element && element.ownerDocument || document;
    const rootBody = ownerDoc && ownerDoc.body;
    let current = element && element.parentElement;
    let fallback = extractors.normalizeSpaces(
      (element && (element.getAttribute && element.getAttribute("title"))) ||
      (element && element.textContent)
    );
    for (let depth = 0; current && current !== rootBody && depth < 4; depth += 1) {
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

  function getEminwonFileCheckboxes(contexts, rootDoc) {
    const expectedCount = contexts.length;
    if (expectedCount === 0) {
      return [];
    }
    const doc = rootDoc || document;
    const checkboxes = Array.from(doc.querySelectorAll("input[type='checkbox']"))
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

  function dispatchMouseEvent(element, type) {
    if (!element || typeof element.dispatchEvent !== "function") {
      return true;
    }
    const view = element.ownerDocument && element.ownerDocument.defaultView || window;
    return element.dispatchEvent(new view.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view
    }));
  }

  function dispatchSimpleEvent(element, type) {
    if (!element || typeof element.dispatchEvent !== "function") {
      return true;
    }
    const view = element.ownerDocument && element.ownerDocument.defaultView || window;
    return element.dispatchEvent(new view.Event(type, { bubbles: true }));
  }

  function activateElement(element) {
    if (!element) {
      return;
    }
    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }
    dispatchMouseEvent(element, "mousedown");
    dispatchMouseEvent(element, "mouseup");
    if (typeof element.click === "function") {
      element.click();
    } else {
      dispatchMouseEvent(element, "click");
    }
  }

  function setCheckboxChecked(checkbox, checked) {
    if (!checkbox) {
      return;
    }
    if (checkbox.checked !== checked && typeof checkbox.click === "function" && !checkbox.disabled) {
      activateElement(checkbox);
    }
    if (checkbox.checked === checked) {
      return;
    }
    checkbox.checked = checked;
    dispatchSimpleEvent(checkbox, "input");
    dispatchSimpleEvent(checkbox, "change");
  }

  function isEnabledControl(control) {
    return Boolean(control) &&
      !control.disabled &&
      control.getAttribute("aria-disabled") !== "true" &&
      control.getAttribute("disabled") === null;
  }

  function isVisibleControl(control) {
    if (!control) {
      return false;
    }
    if (control.offsetParent !== null) {
      return true;
    }
    const rects = control.getClientRects ? control.getClientRects() : [];
    return rects && rects.length > 0;
  }

  function controlPriority(control) {
    let score = 0;
    if (isVisibleControl(control)) {
      score += 4;
    }
    if (isEnabledControl(control)) {
      score += 4;
    }
    const text = extractors.controlSearchText(control);
    if (/^\s*\uB2E4\uC6B4\uB85C\uB4DC\s*$/.test(text)) {
      score += 3;
    }
    if (/\uC804\uCCB4|\uBAA8\uB450|zip/i.test(text)) {
      score -= 5;
    }
    return score;
  }

  function getEminwonRegularDownloadButton(triggerControl, rootDoc) {
    if (extractors.classifyEminwonDownloadControl(triggerControl) === "download") {
      return triggerControl;
    }

    const doc = rootDoc || document;
    const controls = Array.from(doc.querySelectorAll(EMINWON_CONTROL_SELECTOR))
      .filter((control) =>
        control !== triggerControl &&
        isEnabledControl(control) &&
        extractors.classifyEminwonDownloadControl(control) === "download"
      )
      .sort((left, right) => controlPriority(right) - controlPriority(left));
    return controls[0] || null;
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

  function uniqueDocuments(docs) {
    const seen = [];
    (docs || []).forEach((doc) => {
      if (doc && !seen.includes(doc)) {
        seen.push(doc);
      }
    });
    return seen;
  }

  function eminwonControlDocuments(control) {
    const docs = [];
    if (control && control.ownerDocument) {
      docs.push(control.ownerDocument);
    }
    docs.push(document);
    accessibleChildDocuments().forEach((doc) => docs.push(doc));
    return uniqueDocuments(docs);
  }

  function buildEminwonDownloadPlanInDocument(rootDoc, control, forcedTriggerKind, contexts) {
    const triggerKind = forcedTriggerKind || extractors.classifyEminwonDownloadControl(control);
    if (!triggerKind) {
      return createPlanFailure("not-download-control");
    }

    const checkboxes = getEminwonFileCheckboxes(contexts, rootDoc);
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
    const downloadButton = getEminwonRegularDownloadButton(control, rootDoc);

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

  function buildEminwonDownloadPlan(control, forcedTriggerKind) {
    const triggerKind = forcedTriggerKind || extractors.classifyEminwonDownloadControl(control);
    if (!triggerKind) {
      return createPlanFailure("not-download-control");
    }

    const contexts = buildEminwonContexts();
    if (contexts.length === 0) {
      return createPlanFailure("no-eminwon-contexts");
    }

    let lastFailure = null;
    for (const rootDoc of eminwonControlDocuments(control)) {
      const plan = buildEminwonDownloadPlanInDocument(rootDoc, control, triggerKind, contexts);
      if (plan.ok) {
        return plan;
      }
      lastFailure = plan;
    }

    return lastFailure || createPlanFailure("no-control-document");
  }

  function sendSingleEminwonContextForNativeDownload(control) {
    if (!extensionEnabled || eminwonDownloadQueueRunning) {
      return;
    }

    const triggerKind = extractors.classifyEminwonDownloadControl(control);
    if (!triggerKind) {
      return;
    }

    const contexts = buildEminwonContexts();
    const checkboxes = getEminwonFileCheckboxes(
      contexts,
      control && control.ownerDocument || document
    );
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

  function contextForQueueDownload(plan, targetIndex, position) {
    const context = Object.assign({}, plan.contexts[targetIndex]);
    if (plan.targetIndexes.length > 1) {
      context.sequenceNumber = String(position + 1);
    }
    context.queueBatchId = plan.queueBatchId;
    context.queueOrder = String(position + 1);
    context.queueTargetIndex = String(targetIndex);
    context.capturedAt = Date.now();
    return context;
  }

  function stopDownloadEvent(event) {
    event.preventDefault();
    if (event.stopImmediatePropagation) {
      event.stopImmediatePropagation();
    } else {
      event.stopPropagation();
    }
  }

  function clickEminwonDownloadButton(button) {
    eminwonQueueClickInProgress = true;
    try {
      activateElement(button);
    } finally {
      eminwonQueueClickInProgress = false;
    }
  }

  function settleEminwonQueueWaiter(result) {
    if (!eminwonQueueWaiter) {
      return false;
    }
    const waiter = eminwonQueueWaiter;
    eminwonQueueWaiter = null;
    window.clearTimeout(waiter.timeoutId);
    waiter.done(result || {});
    return true;
  }

  function clearEminwonQueueWaiter() {
    if (!eminwonQueueWaiter) {
      return;
    }
    window.clearTimeout(eminwonQueueWaiter.timeoutId);
    eminwonQueueWaiter = null;
  }

  function matchesEminwonQueueWaiter(message) {
    if (!eminwonQueueWaiter || !message) {
      return false;
    }
    return message.queueBatchId === eminwonQueueWaiter.queueBatchId &&
      String(message.queueOrder || "") === String(eminwonQueueWaiter.queueOrder || "");
  }

  function waitForEminwonQueueDownloadStart(context, done) {
    clearEminwonQueueWaiter();
    const timeoutId = window.setTimeout(() => {
      settleEminwonQueueWaiter({
        started: false,
        reason: "download-start-timeout"
      });
    }, EMINWON_QUEUE_ACK_TIMEOUT_MS);

    eminwonQueueWaiter = {
      queueBatchId: context.queueBatchId,
      queueOrder: context.queueOrder,
      timeoutId,
      done
    };
  }

  function runEminwonDownloadQueue(plan, options) {
    const opts = options || {};
    plan.queueBatchId = plan.queueBatchId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    eminwonDownloadQueueRunning = true;
    const originalStates = plan.checkboxes.map((checkbox) => checkbox.checked);
    let position = 0;

    const runNext = () => {
      if (position >= plan.targetIndexes.length) {
        restoreCheckboxes(plan.checkboxes, originalStates);
        eminwonDownloadQueueRunning = false;
        clearEminwonQueueWaiter();
        return;
      }

      const targetIndex = plan.targetIndexes[position];
      plan.checkboxes.forEach((checkbox, index) => {
        setCheckboxChecked(checkbox, index === targetIndex);
      });
      const context = contextForQueueDownload(plan, targetIndex, position);
      sendContext(context);

      waitForEminwonQueueDownloadStart(context, () => {
        position += 1;
        window.setTimeout(runNext, EMINWON_QUEUE_AFTER_ACK_DELAY_MS);
      });

      if (position === 0 && opts.immediateFirstClick) {
        clickEminwonDownloadButton(plan.downloadButton);
      } else {
        window.setTimeout(() => {
          clickEminwonDownloadButton(plan.downloadButton);
        }, EMINWON_QUEUE_CLICK_DELAY_MS);
      }
    };

    runNext();
  }

  function handleEminwonDownloadIntercept(event) {
    if (!extensionEnabled) {
      return false;
    }

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
      if (triggerKind === "all") {
        debugWarn("e-minwon ZIP trigger observed without local queue plan", {
          reason: plan.reason || "single-target",
          detail: plan.detail || {
            targetCount: plan.targetIndexes && plan.targetIndexes.length
          },
          localContextCount: buildEminwonContexts().length,
          href: location.href
        });
      }
      return false;
    }

    stopDownloadEvent(event);
    runEminwonDownloadQueue(plan, { immediateFirstClick: true });
    return true;
  }

  function startEminwonQueueFromCurrentPage() {
    if (!extensionEnabled) {
      return {
        started: false,
        reason: "extension-disabled"
      };
    }

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

  function broadcastEminwonQueueToChildFrames(downloadId, callback) {
    const done = typeof callback === "function" ? callback : null;
    if (!extensionEnabled) {
      if (done) {
        done({
          started: false,
          reason: "extension-disabled"
        });
      }
      return 0;
    }

    const frames = childFrames();
    if (frames.length === 0) {
      return 0;
    }

    const contexts = buildEminwonContexts();
    let pending = frames.length;
    let finished = false;
    let lastResult = null;
    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (done) {
        done(result);
      }
    };

    const timeoutId = done ? window.setTimeout(() => {
      finish(lastResult || {
        started: false,
        reason: "child-frame-timeout",
        detail: {
          childFrameCount: frames.length
        }
      });
    }, 1200) : null;

    frames.forEach((frame) => {
      const message = {
        type: EMINWON_QUEUE_BRIDGE_TYPE,
        downloadId,
        contexts: clonePlain(contexts) || contexts,
        expectsResponse: Boolean(done)
      };

      if (done && typeof MessageChannel !== "undefined") {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          const result = event && event.data;
          if (result && result.started) {
            if (timeoutId) {
              window.clearTimeout(timeoutId);
            }
            finish(result);
            return;
          }
          lastResult = result || { started: false, reason: "empty-child-response" };
          pending -= 1;
          if (pending === 0) {
            if (timeoutId) {
              window.clearTimeout(timeoutId);
            }
            finish(lastResult);
          }
        };
        frame.contentWindow.postMessage(message, "*", [channel.port2]);
        return;
      }

      frame.contentWindow.postMessage(message, "*");
    });
    return frames.length;
  }

  function startEminwonQueueOrBroadcast(downloadId, callback) {
    const result = startEminwonQueueFromCurrentPage();
    if (result.started) {
      callback(result);
      return;
    }

    const childFrameCount = broadcastEminwonQueueToChildFrames(downloadId, (childResult) => {
      if (childResult && childResult.started) {
        callback(Object.assign({}, childResult, {
          reason: childResult.reason || "child-frame-started"
        }));
        return;
      }
      callback({
        started: false,
        reason: "local-and-child-queue-failed",
        detail: {
          childFrameCount,
          localReason: result.reason,
          localDetail: result.detail,
          childResult
        }
      });
    });

    if (childFrameCount === 0) {
      callback(result);
    }
  }

  function captureDownloadIntent(event) {
    if (!extensionEnabled) {
      return;
    }

    const control = event.target && event.target.closest
      ? event.target.closest("a, button, input, [onclick], [data-url], [data-filename]")
      : null;

    if (isEminwonContextFrame()) {
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
    if (!extensionEnabled) {
      return;
    }

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
    if (!extensionEnabled) {
      return;
    }

    if (isEminwonContextFrame()) {
      if (event.type === "pointerdown" || event.type === "mousedown") {
        return;
      }
      handleEminwonDownloadIntercept(event);
      return;
    }
    handleZipDownloadIntercept(event);
  }

  function installEminwonChildFrameInterceptors() {
    if (!extensionEnabled || sourceName() !== "e-minwon") {
      return 0;
    }

    let installed = 0;
    accessibleChildDocuments().forEach((doc) => {
      const view = doc.defaultView;
      if (!view || !hasRaonUploadControls(doc) || doc[EMINWON_CHILD_INTERCEPT_MARK]) {
        return;
      }
      doc[EMINWON_CHILD_INTERCEPT_MARK] = true;

      doc.addEventListener("pointerdown", handleDownloadIntercept, true);
      doc.addEventListener("mousedown", handleDownloadIntercept, true);
      doc.addEventListener("click", handleDownloadIntercept, true);
      doc.addEventListener("click", captureDownloadIntent, true);
      doc.addEventListener("pointerdown", captureDownloadIntent, true);
      doc.addEventListener("keydown", function interceptChildKeyboardDownload(event) {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        handleDownloadIntercept(event);
        captureDownloadIntent(event);
      }, true);
      installed += 1;
    });
    return installed;
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

  window.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data) {
      return;
    }
    if (!extensionEnabled) {
      if (data.type === EMINWON_QUEUE_BRIDGE_TYPE && data.expectsResponse && event.ports && event.ports[0]) {
        event.ports[0].postMessage({
          started: false,
          reason: "extension-disabled"
        });
      }
      return;
    }

    if (data.type === EMINWON_CONTEXT_BRIDGE_TYPE) {
      storeBridgedEminwonContexts(data.contexts);
      return;
    }

    if (data.type === EMINWON_CONTEXT_REQUEST_TYPE) {
      if (!isEminwonContextFrame()) {
        return;
      }
      const contexts = buildEminwonContexts();
      if (contexts.length === 0 || !event.source || typeof event.source.postMessage !== "function") {
        return;
      }
      event.source.postMessage({
        type: EMINWON_CONTEXT_BRIDGE_TYPE,
        contexts: clonePlain(contexts) || contexts
      }, "*");
      return;
    }

    if (data.type !== EMINWON_QUEUE_BRIDGE_TYPE) {
      return;
    }

    storeBridgedEminwonContexts(data.contexts);
    if (!isEminwonContextFrame()) {
      const result = {
        started: false,
        reason: "not-eminwon-frame",
        detail: {
          href: location.href
        }
      };
      if (data.expectsResponse && event.ports && event.ports[0]) {
        event.ports[0].postMessage(result);
      }
      return;
    }

    const result = startEminwonQueueFromCurrentPage();
    if (data.expectsResponse && event.ports && event.ports[0]) {
      event.ports[0].postMessage(result);
    }
    if (!result.started) {
      debugWarn("e-minwon child frame queue did not start", result);
    }
  });

  function sendAllPageContexts() {
    if (!extensionEnabled) {
      return;
    }

    if (isEminwonContextFrame()) {
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
    if (message && message.type === EMINWON_QUEUE_DOWNLOAD_STARTED_TYPE) {
      const matched = matchesEminwonQueueWaiter(message);
      if (matched) {
        settleEminwonQueueWaiter({
          started: true,
          downloadId: message.downloadId,
          filename: message.filename || ""
        });
      }
      sendResponse({
        received: matched
      });
      return;
    }

    if (message && message.type === START_EMINWON_QUEUE_TYPE) {
      if (!extensionEnabled) {
        sendResponse({
          started: false,
          reason: "extension-disabled"
        });
        return;
      }
      if (!isEminwonContextFrame()) {
        sendResponse({
          started: false,
          reason: "not-eminwon-frame",
          detail: {
            href: location.href
          }
        });
        return;
      }
      startEminwonQueueOrBroadcast(message.downloadId, sendResponse);
      return true;
    }

    if (message && message.type === "get-report-title") {
      if (isEminwonContextFrame()) {
        const context = buildEminwonContexts()[0];
        sendResponse(eminwonMetadataFromContext(context) || { reportTitle: "" });
        return;
      }
      const reportTitle = extractors.extractReportTitleFromDocument(document);
      sendResponse({ reportTitle: reportTitle || "" });
    }
  });

  function extractAndReportMetadata() {
    if (!extensionEnabled || !chrome.runtime || !chrome.runtime.sendMessage) {
      return;
    }

    if (isEminwonContextFrame()) {
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
    const hasDownloadControl = Array.from(document.querySelectorAll("a, button, input"))
      .some((el) => extractors.isDownloadControl(el));
    const visibleText = pageText();
    const reportTitle = tableFacts.reportTitle || extractors.extractReportTitleFromDocument(document);
    const isTableExtract = Boolean(tableFacts.reportTitle);
    if (!isTableExtract && !hasDownloadControl) {
      return;
    }
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
    if (!extensionEnabled) {
      return;
    }

    requestEminwonContextsFromParent();
    reportPageReady();
    extractAndReportMetadata();
    sendAllPageContexts();
    broadcastEminwonContextsToChildFrames();
    installEminwonChildFrameInterceptors();
  }

  observeExtensionSettings();
  loadExtensionSettings(() => {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      runPageInitialization();
    } else {
      document.addEventListener("DOMContentLoaded", runPageInitialization);
    }
    window.setTimeout(runPageInitialization, 1000);
    window.setTimeout(runPageInitialization, 3000);
    window.setTimeout(runPageInitialization, 6000);
  });
})();
