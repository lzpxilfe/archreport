(function initSitePolicy(global) {
  "use strict";

  // Keep this file identical in archreport and paper-rename-extension.
  // A proxy can encode the original hostname, wrap a URL, or serve a blob.
  // Inspect URL hosts rather than arbitrary words in filenames/search queries.
  const ACADEMIC = /(?:^|\.)(?:riss\.kr|dbpia\.(?:co\.kr|com)|kiss\.kstudy\.com|kci\.go\.kr|earticle\.net|scholar\.kyobobook\.co\.kr|koreascience\.(?:or\.kr|kr)|scienceon\.kisti\.re\.kr|krm\.or\.kr|nanet\.go\.kr|nl\.go\.kr|scholar\.google\.[a-z.]+|dcollection(?:\.net|\.[a-z0-9.-]+)|history\.seoul\.go\.kr)(?:\.|$)/i;
  const REPORT = /(?:^|\.)(?:heritage\.go\.kr|nrich\.go\.kr|nihc\.go\.kr|gogung\.go\.kr|khs\.go\.kr|cha\.go\.kr|nch\.go\.kr|e[.-]minwon\.go\.kr|cihc\.or\.kr|iha\.go\.kr|116\.67\.83\.213)(?:\.|$)/i;

  function urlCandidates(value) {
    const result = [];
    const seen = new Set();
    const queue = [{ value: String(value || ""), depth: 0 }];
    while (queue.length && result.length < 12) {
      const next = queue.shift();
      if (next.depth > 3 || seen.has(next.value)) continue;
      seen.add(next.value);
      let url;
      try { url = new URL(next.value); } catch (_error) { continue; }
      if (url.protocol === "blob:") {
        queue.push({ value: url.pathname, depth: next.depth + 1 });
        continue;
      }
      if (!/^https?:$/.test(url.protocol)) continue;
      result.push(url);
      // Only unwrap URL-valued parameters, never a free-text search query.
      for (const key of ["url", "target", "dest", "destination", "redirect", "redirectUrl", "redirect_uri", "qurl"]) {
        let embedded = url.searchParams.get(key) || "";
        for (let i = 0; i < 2 && !/^https?:\/\//i.test(embedded); i++) {
          try { embedded = decodeURIComponent(embedded); } catch (_error) { break; }
        }
        if (/^https?:\/\//i.test(embedded)) queue.push({ value: embedded, depth: next.depth + 1 });
      }
      let pathname = url.pathname;
      try { pathname = decodeURIComponent(pathname); } catch (_error) {}
      const embeddedPath = pathname.match(/https?:\/\/[^\s]+/i);
      if (embeddedPath) queue.push({ value: embeddedPath[0], depth: next.depth + 1 });
    }
    return result;
  }

  function normalizedHost(url) {
    return url.hostname.toLowerCase().replace(/-ssl(?=\.|$)/g, "").replace(/-/g, ".");
  }

  function matches(url, pattern) {
    // Check the real hostname first: e-minwon is a legitimate hyphenated name.
    return pattern.test(url.hostname) || pattern.test(normalizedHost(url));
  }

  function isReportSite(value) {
    return urlCandidates(value).some(url => matches(url, REPORT));
  }

  function isAcademicSite(value) {
    return !isReportSite(value) && urlCandidates(value).some(url => matches(url, ACADEMIC));
  }

  function academicSourceUrl(value) {
    const candidates = urlCandidates(value);
    const url = candidates.slice().reverse().find(candidate => matches(candidate, ACADEMIC));
    if (!url) return value || "";
    const normalized = new URL(url.href);
    normalized.hostname = normalizedHost(url);
    return normalized.href;
  }

  function sameUrl(left, right) {
    if (!left || !right) return false;
    try {
      const a = new URL(left), b = new URL(right);
      a.hash = "";
      b.hash = "";
      return a.href === b.href;
    } catch (_error) { return false; }
  }

  const api = { isAcademicSite, isReportSite, academicSourceUrl, sameUrl, urlCandidates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.DownloadSitePolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
