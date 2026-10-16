const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, hasListener(fn) { return listeners.includes(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
}
const registry = new Map();
function createWorker(root, options = {}) {
  const data = structuredClone(options.data || {}), warnings = [], badges = [], external = [];
  const timers = new Set();
  const area = { get(key, cb) { if (!options.hangStorage) cb(Object.fromEntries([].concat(key).map(k => [k, structuredClone(data[k])]))); },
    set(values, cb) { Object.assign(data, structuredClone(values)); cb?.(); }, remove(key) { for (const k of [].concat(key)) delete data[k]; } };
  const chrome = {
    runtime: { id: options.id || 'random-unpacked-id', lastError: undefined, onInstalled: event(), onStartup: event(), onMessage: event(), onMessageExternal: event(), openOptionsPage() {},
      // 확장 간 메시지: 같은 테스트 안에서 만든 다른 워커(registry)에게만 전달된다.
      sendMessage(...args) {
        if (typeof args[0] !== 'string') throw new Error('Unexpected internal sendMessage in worker');
        const [targetId, message, callback] = args;
        external.push([targetId, message]);
        const target = registry.get(targetId);
        setTimeout(() => {
          if (!target) {
            chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            try { callback?.(); } finally { chrome.runtime.lastError = undefined; }
            return;
          }
          let responded = false;
          const respond = value => { if (!responded) { responded = true; setTimeout(() => callback?.(structuredClone(value)), 0); } };
          const results = target.chrome.runtime.onMessageExternal.listeners.map(fn => fn(structuredClone(message), { id: chrome.runtime.id }, respond));
          if (!results.includes(true) && !responded) respond(undefined);
        }, 0);
      } },
    storage: { sync: area, local: area, session: area, onChanged: event() },
    action: { onClicked: event(), setBadgeText(v) { badges.push(v.text); }, setBadgeBackgroundColor() {}, setTitle() {} },
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event(), query(_, cb) { cb(options.tabs || [{ id: 22, windowId: 1 }]); }, sendMessage(...args) { args.at(-1)?.({}); } },
    windows: { getLastFocused(_, cb) { cb({ id: 1 }); } },
    downloads: { onCreated: event(), onChanged: event(), onDeterminingFilename: event(), search(_, cb) { cb([]); } }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, AbortController,
    console: { log() {}, warn(...args) { warnings.push(args); }, error(...args) { warnings.push(args); } },
    navigator: { platform: 'Win32' },
    setTimeout(fn, ms) { const t = setTimeout(fn, options.fastTimeouts ? Math.min(ms, 30) : ms); t.unref(); timers.add(t); return t; }, clearTimeout });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file }));
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8'), context, { filename: 'background.js' });
  const message = (payload, sender = { tab: { id: 22 }, frameId: 0 }) => {
    let response;
    chrome.runtime.onMessage.listeners.forEach(fn => fn(payload, sender, value => { response = value; }));
    return response;
  };
  const download = item => Promise.all(chrome.downloads.onDeterminingFilename.listeners.slice().map(fn => new Promise((resolve, reject) => {
    let called = false;
    const watchdog = setTimeout(() => reject(new Error('Download listener did not settle')), 7000);
    const suggest = value => { if (called) throw new Error('suggest called twice'); called = true; clearTimeout(watchdog); resolve(value); };
    try { const result = fn(item, suggest); if (!called && result !== true) suggest(); } catch (error) { clearTimeout(watchdog); reject(error); }
  })));
  const worker = { chrome, data, context, warnings, badges, external, message, download, dispose() { timers.forEach(clearTimeout); if (registry.get(chrome.runtime.id) === worker) registry.delete(chrome.runtime.id); } };
  if (options.register !== false) registry.set(chrome.runtime.id, worker);
  return worker;
}
module.exports = { createWorker };
