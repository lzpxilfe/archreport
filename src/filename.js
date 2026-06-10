(function initFilenameModule(global) {
  "use strict";

  const FIELD_LABELS = {
    reportTitle: "보고서제목",
    attachmentTitle: "첨부파일명",
    year: "발행연도",
    agency: "발행기관",
    permitNumber: "허가번호",
    siteName: "유적명",
    submittedDate: "제출일",
    province: "조사 시도",
    district: "조사 시군구",
    originalFilename: "원본파일명",
    sequenceNumber: "번호"
  };

  const DEFAULT_TEMPLATE = [
    { kind: "field", value: "agency" },
    { kind: "separator", value: "commaSpace" },
    { kind: "field", value: "year" },
    { kind: "separator", value: "commaSpace" },
    { kind: "field", value: "reportTitle" },
    { kind: "separator", value: "space" },
    { kind: "field", value: "attachmentTitle" }
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    template: DEFAULT_TEMPLATE
  };

  const SEPARATOR_VALUES = {
    space: " ",
    commaSpace: ", ",
    underscore: "_",
    hyphen: "-",
    openParen: "(",
    closeParen: ")"
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeSpaces(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeComparable(value) {
    return normalizeSpaces(value)
      .replace(/[ㆍ·]/g, "")
      .replace(/[(){}\[\]<>「」『』,.;:，。·ㆍ\-_\s]/g, "")
      .toLowerCase();
  }

  function stripPdfExtension(value) {
    return String(value || "").replace(/\.pdf$/i, "");
  }

  function extensionFromFilename(filename) {
    const clean = String(filename || "").split(/[?#]/)[0];
    const match = clean.match(/\.([A-Za-z0-9]{1,8})$/);
    return match ? `.${match[1].toLowerCase()}` : "";
  }

  function filenameFromUrl(url) {
    if (!url) {
      return "";
    }
    try {
      const parsed = new URL(url, "https://example.invalid");
      const fileParam = parsed.searchParams.get("file");
      if (fileParam) {
        return decodeURIComponent(fileParam.split("/").pop() || "");
      }
      return decodeURIComponent(parsed.pathname.split("/").pop() || "");
    } catch (_error) {
      const withoutQuery = String(url).split(/[?#]/)[0];
      try {
        return decodeURIComponent(withoutQuery.split("/").pop() || "");
      } catch (_decodeError) {
        return withoutQuery.split("/").pop() || "";
      }
    }
  }

  function sanitizeFilenameBase(value) {
    const cleaned = stripPdfExtension(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();

    return cleaned.slice(0, 180);
  }

  function resolveSeparator(token) {
    if (!token) {
      return "";
    }
    if (token.value === "custom") {
      return String(token.text || "");
    }
    return SEPARATOR_VALUES[token.value] || String(token.text || token.value || "");
  }

  function fieldValue(field, context) {
    const value = context && Object.prototype.hasOwnProperty.call(context, field)
      ? context[field]
      : "";
    return stripPdfExtension(normalizeSpaces(value));
  }

  function deriveAttachmentTitle(reportTitle, fileTitle, originalFilename) {
    const fileStem = stripPdfExtension(normalizeSpaces(fileTitle || originalFilename || ""));
    const report = normalizeSpaces(reportTitle);
    if (!fileStem) {
      return "";
    }
    if (/^(원본|본문|다운로드|download|file|report|includeFileDownLoad)$/i.test(fileStem)) {
      return "";
    }
    if (normalizeComparable(fileStem) === normalizeComparable(report)) {
      return "";
    }

    const meaningfulSuffix = fileStem.match(/((?:제\s*)?\d+\s*권\s*\([^)]*\)|(?:제\s*)?\d+\s*권|도면\s*\d+|도판\s*\d+|부록\s*\d*|별책|상권|하권|본문|원색도판|사진도판)(?:.*)?$/);
    if (meaningfulSuffix && meaningfulSuffix[1]) {
      return normalizeSpaces(meaningfulSuffix[1]);
    }

    return fileStem;
  }

  function withDerivedContext(context) {
    const next = Object.assign({}, context || {});
    next.originalFilename = normalizeSpaces(next.originalFilename || filenameFromUrl(next.downloadUrl || ""));
    next.fileTitle = normalizeSpaces(next.fileTitle || next.originalFilename);
    next.reportTitle = normalizeSpaces(next.reportTitle || next.title || "");
    next.attachmentTitle = normalizeSpaces(
      next.attachmentTitle || deriveAttachmentTitle(next.reportTitle, next.fileTitle, next.originalFilename)
    );
    next.year = normalizeSpaces(next.year || "");
    next.agency = normalizeSpaces(next.agency || "");
    next.permitNumber = normalizeSpaces(next.permitNumber || "");
    next.siteName = normalizeSpaces(next.siteName || "");
    next.submittedDate = normalizeSpaces(next.submittedDate || "");
    next.province = normalizeSpaces(next.province || "");
    next.district = normalizeSpaces(next.district || "");
    next.sequenceNumber = normalizeSpaces(next.sequenceNumber || "");
    return next;
  }

  function renderTemplate(context, settings) {
    const activeSettings = settings && Array.isArray(settings.template)
      ? settings
      : DEFAULT_SETTINGS;
    const derivedContext = withDerivedContext(context);

    let output = "";
    let pendingSeparator = "";
    let hasValue = false;

    for (const token of activeSettings.template) {
      if (!token || !token.kind) {
        continue;
      }

      if (token.kind === "separator") {
        pendingSeparator = resolveSeparator(token);
        continue;
      }

      let value = "";
      if (token.kind === "field") {
        value = fieldValue(token.value, derivedContext);
      } else if (token.kind === "text") {
        value = normalizeSpaces(token.value || token.text || "");
      }

      if (!value) {
        continue;
      }

      if (hasValue) {
        output += pendingSeparator || "";
      }
      output += value;
      hasValue = true;
      pendingSeparator = "";
    }

    return sanitizeFilenameBase(output);
  }

  function fallbackBase(context) {
    const derivedContext = withDerivedContext(context);
    return sanitizeFilenameBase(
      derivedContext.reportTitle ||
      stripPdfExtension(derivedContext.originalFilename) ||
      "국가유산 보고서"
    );
  }

  function renderFilename(context, settings, downloadItem) {
    const base = renderTemplate(context, settings) || fallbackBase(context);
    const derivedContext = withDerivedContext(context);
    const extension =
      extensionFromFilename(derivedContext.originalFilename) ||
      extensionFromFilename(downloadItem && downloadItem.filename) ||
      extensionFromFilename(downloadItem && downloadItem.url) ||
      ".pdf";

    return `${base}${extension}`;
  }

  function mergeSettings(stored) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    if (!Array.isArray(settings.template) || settings.template.length === 0) {
      settings.template = clone(DEFAULT_TEMPLATE);
    }
    return settings;
  }

  const api = {
    DEFAULT_SETTINGS,
    DEFAULT_TEMPLATE,
    FIELD_LABELS,
    SEPARATOR_VALUES,
    clone,
    deriveAttachmentTitle,
    extensionFromFilename,
    filenameFromUrl,
    mergeSettings,
    normalizeComparable,
    normalizeSpaces,
    renderFilename,
    renderTemplate,
    sanitizeFilenameBase,
    stripPdfExtension,
    withDerivedContext
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ArchReportFilename = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
