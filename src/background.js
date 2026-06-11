if (typeof importScripts === "function") {
  importScripts("filename.js");
} else if (typeof require === "function" && typeof globalThis.ArchReportFilename === "undefined") {
  globalThis.ArchReportFilename = require("./filename.js");
}

const MESSAGE_TYPE = "arch-report-download-context";
const PAGE_READY_TYPE = "arch-report-page-ready";
const START_EMINWON_QUEUE_TYPE = "arch-report-start-eminwon-download-queue";
const STORAGE_KEY = "archReportSettings";
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXTS = 30;
const DOWNLOAD_STATE_TTL_MS = 10 * 60 * 1000;
const ZIP_REMOVE_RETRY_DELAYS_MS = [0, 500, 2000];
const EMINWON_HOST = "e-minwon.go.kr";
const DOWNLOAD_DEBUG_PREFIX = "[archreport]";

let settingsCache = ArchReportFilename.mergeSettings();
let pendingContexts = [];
let tabSources = {};
let zipDownloadStates = {};

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

function loadSettings() {
  if (!hasChromeApi(["storage", "sync", "get"])) {
    return;
  }
  chrome.storage.sync.get(STORAGE_KEY, (result) => {
    settingsCache = ArchReportFilename.mergeSettings(result && result[STORAGE_KEY]);
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
  return ArchReportFilename.filenameFromUrl(value || "");
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
  const isEminwon = source === "e-minwon" || String(pageUrl || "").includes(EMINWON_HOST);
  if (isEminwon || entry.source === "unknown") {
    entry.source = isEminwon ? "e-minwon" : source;
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
      (frame.source === "e-minwon" || String(frame.pageUrl || "").includes(EMINWON_HOST))
    )
    .map(([frameId]) => Number(frameId))
    .filter((frameId) => Number.isInteger(frameId) && frameId >= 0);
}

function isLikelyEminwonDownload(item) {
  if (hasEminwonUrl(item)) {
    return true;
  }

  const source = item && Number.isInteger(item.tabId) ? tabSource(item.tabId) : null;
  if (source && (source.source === "e-minwon" || String(source.pageUrl || "").includes(EMINWON_HOST))) {
    return true;
  }

  return pendingContexts.some((entry) =>
    entry.context &&
    entry.context.source === "e-minwon" &&
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

function requestEminwonQueue(downloadItem) {
  if (!downloadItem || downloadItem.tabId < 0 || !hasChromeApi(["tabs", "sendMessage"])) {
    return;
  }

  const state = zipState(downloadItem.id);
  if (state.queueRequested) {
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
        return;
      }
      if (response && response.started) {
        finished = true;
        return;
      }
      debugWarn("e-minwon queue did not start", {
        downloadId: downloadItem.id,
        frameId: respondedFrameId,
        reason: response && response.reason,
        detail: response && response.detail
      });
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
  requestEminwonQueue(downloadItem);

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
}

function maybeCancelEminwonZip(downloadItem) {
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

function chooseContext(item) {
  const now = Date.now();
  cleanupContexts(now);

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
  return best.entry.context;
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
    settingsCache = ArchReportFilename.mergeSettings(changes[STORAGE_KEY].newValue);
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message) {
      return;
    }

    if (message.type === "report-metadata-extracted" && sender && sender.tab) {
      const tabId = sender.tab.id;
      const metadata = message.metadata;
      const source = metadata && metadata.url && metadata.url.includes(EMINWON_HOST) ? "e-minwon" : "unknown";
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
      const context = ArchReportFilename.withDerivedContext(message.context);
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

  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    if (!settingsCache.enabled) {
      suggest();
      return;
    }

    if (maybeCancelEminwonZip(downloadItem)) {
      suggest();
      return;
    }

    const context = chooseContext(downloadItem);
    if (!context) {
      suggest();
      return;
    }

    const filename = ArchReportFilename.renderFilename(context, settingsCache, downloadItem);
    suggest({
      filename,
      conflictAction: "uniquify"
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove([`reportMetadata_${tabId}`]);
    delete tabSources[String(tabId)];
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      chrome.storage.local.remove([`reportMetadata_${tabId}`]);
      delete tabSources[String(tabId)];
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
      reset() {
        pendingContexts = [];
        tabSources = {};
        zipDownloadStates = {};
        settingsCache = ArchReportFilename.mergeSettings();
      }
    },
    cleanupContexts,
    chooseContext,
    eminwonFrameIds,
    isLikelyEminwonDownload,
    isZipDownload,
    maybeCancelEminwonZip,
    rememberTabSource,
    sendQueueMessage,
    zipState
  };
}
