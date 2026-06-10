importScripts("filename.js");

const MESSAGE_TYPE = "arch-report-download-context";
const STORAGE_KEY = "archReportSettings";
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_CONTEXTS = 30;

let settingsCache = ArchReportFilename.mergeSettings();
let pendingContexts = [];

function loadSettings() {
  chrome.storage.sync.get(STORAGE_KEY, (result) => {
    settingsCache = ArchReportFilename.mergeSettings(result && result[STORAGE_KEY]);
  });
}

function cleanupContexts(now) {
  pendingContexts = pendingContexts
    .filter((entry) => now - entry.context.capturedAt < CONTEXT_TTL_MS)
    .slice(-MAX_CONTEXTS);
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

  // Host matching for downloads with tabId: -1
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
    const key = `reportMetadata_${tabId}`;
    chrome.storage.local.get(key, (result) => {
      const existing = result[key];
      if (!existing || metadata.isTableExtract || !existing.isTableExtract) {
        chrome.storage.local.set({ [key]: metadata });
      }
    });
    return;
  }

  if (message.type === MESSAGE_TYPE && message.context) {
    const context = ArchReportFilename.withDerivedContext(message.context);
    context.capturedAt = context.capturedAt || Date.now();

    pendingContexts.push({
      context,
      tabId: sender && sender.tab ? sender.tab.id : -1,
      frameId: sender ? sender.frameId : 0
    });
    cleanupContexts(Date.now());
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (!settingsCache.enabled) {
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
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.storage.local.remove([`reportMetadata_${tabId}`]);
  }
});
