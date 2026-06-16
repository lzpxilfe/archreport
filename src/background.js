if (typeof importScripts === "function") {
  importScripts("constants.js", "filename.js");
} else if (typeof require === "function") {
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

let settingsCache = filenameModule.mergeSettings();
let pendingContexts = [];
let tabSources = {};
let zipDownloadStates = {};
let downloadFilenameListenerRegistered = false;
let downloadFilenameListenerTimer = null;
let downloadFilenameListenerExpiresAt = 0;

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

function clearDownloadFilenameListenerTimer() {
  if (downloadFilenameListenerTimer) {
    clearTimeout(downloadFilenameListenerTimer);
    downloadFilenameListenerTimer = null;
  }
}

function scheduleDownloadFilenameListenerExpiry(now) {
  clearDownloadFilenameListenerTimer();
  const delay = Math.max(0, downloadFilenameListenerExpiresAt - now);
  downloadFilenameListenerTimer = setTimeout(() => {
    downloadFilenameListenerTimer = null;
    if (Date.now() >= downloadFilenameListenerExpiresAt) {
      unregisterDownloadFilenameListener();
    }
  }, delay);
  if (downloadFilenameListenerTimer && typeof downloadFilenameListenerTimer.unref === "function") {
    downloadFilenameListenerTimer.unref();
  }
}

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

function unregisterDownloadFilenameListener() {
  clearDownloadFilenameListenerTimer();
  const event = downloadFilenameEvent();
  if (event && typeof event.removeListener === "function" &&
      (!event.hasListener || event.hasListener(handleDownloadFilenameDetermination))) {
    event.removeListener(handleDownloadFilenameDetermination);
  }
  downloadFilenameListenerRegistered = false;
  downloadFilenameListenerExpiresAt = 0;
}

function armDownloadFilenameListener(now) {
  const armedAt = now || Date.now();
  if (!settingsCache.enabled) {
    unregisterDownloadFilenameListener();
    return false;
  }
  if (!registerDownloadFilenameListener()) {
    return false;
  }
  downloadFilenameListenerExpiresAt = Math.max(
    downloadFilenameListenerExpiresAt,
    armedAt + DOWNLOAD_FILENAME_LISTENER_IDLE_MS
  );
  scheduleDownloadFilenameListenerExpiry(armedAt);
  return true;
}

function refreshDownloadFilenameListener() {
  cleanupContexts(Date.now());
  if (!settingsCache.enabled || pendingContexts.length === 0) {
    unregisterDownloadFilenameListener();
    return false;
  }
  return armDownloadFilenameListener();
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
    updateActionState(settingsCache);
    refreshDownloadFilenameListener();
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

function contextScore(entry, item, now) {
  let score = urlScore(entry.context, item);
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
        (itemTabId >= 0 && entry.tabId === itemTabId) ||
        (itemTabId < 0 && hasEminwonUrl(item))
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

function handleDownloadFilenameDetermination(downloadItem, suggest) {
  let didSuggest = false;
  const safeSuggest = (suggestion) => {
    if (didSuggest) {
      return;
    }
    didSuggest = true;
    suggest(suggestion);
  };

  try {
    if (!settingsCache.enabled) {
      safeSuggest();
      return;
    }

    if (maybeCancelEminwonZip(downloadItem)) {
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
    notifyEminwonQueueDownloadStarted(entry, downloadItem, filename);
  } catch (error) {
    debugWarn("leaving download filename unchanged after filename handler error", {
      downloadId: downloadItem && downloadItem.id,
      message: error && error.message
    });
    safeSuggest();
  } finally {
    refreshDownloadFilenameListener();
  }
}

function registerChromeListeners() {
  if (!hasChromeApi(["runtime"])) {
    return;
  }

  chrome.runtime.onInstalled.addListener(loadSettings);
  chrome.runtime.onStartup.addListener(loadSettings);
  loadSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }
    settingsCache = filenameModule.mergeSettings(changes[STORAGE_KEY].newValue);
    updateActionState(settingsCache);
    refreshDownloadFilenameListener();
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) {
      return;
    }

    if (message.type === REPORT_METADATA_EXTRACTED_TYPE && sender && sender.tab) {
      const tabId = sender.tab.id;
      const metadata = message.metadata;
      const source = metadata && metadata.url && metadata.url.includes(EMINWON_HOST)
        ? EMINWON_SOURCE
        : constants.SOURCES.UNKNOWN;
      rememberTabSource(tabId, source, metadata && metadata.url, sender.frameId);
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
      armDownloadFilenameListener();
    }
  });

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
    refreshDownloadFilenameListener();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      chrome.storage.local.remove([`reportMetadata_${tabId}`]);
      delete tabSources[String(tabId)];
      refreshDownloadFilenameListener();
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
      get downloadFilenameListenerExpiresAt() {
        return downloadFilenameListenerExpiresAt;
      },
      reset() {
        unregisterDownloadFilenameListener();
        pendingContexts = [];
        tabSources = {};
        zipDownloadStates = {};
        settingsCache = filenameModule.mergeSettings();
      },
      setSettings(settings) {
        settingsCache = filenameModule.mergeSettings(settings);
        refreshDownloadFilenameListener();
      }
    },
    armDownloadFilenameListener,
    cleanupContexts,
    chooseContext,
    chooseContextEntry,
    eminwonFrameIds,
    handleDownloadFilenameDetermination,
    isLikelyEminwonDownload,
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
