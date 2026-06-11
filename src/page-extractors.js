(function initExtractorModule(global) {
  "use strict";

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

  function stripTags(html) {
    return normalizeSpaces(String(html || "").replace(/<[^>]*>/g, " "));
  }

  function decodeHtmlEntities(value) {
    return String(value || "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'");
  }

  const REPORT_TITLE_SELECTOR_CANDIDATES = [
    "main h1",
    "main h2",
    "main h3",
    "#contents h1",
    "#contents h2",
    "#contents h3",
    "#content h1",
    "#content h2",
    "#content h3",
    ".detail_view h3",
    ".detail h3",
    ".view h3",
    "h1",
    "h2",
    "h3"
  ];

  const REPORT_TITLE_REJECT_EXACT = new Set([
    "\uAD6D\uAC00\uC720\uC0B0 \uAC04\uD589\uBB3C",
    "\uBCF4\uACE0\uC11C",
    "\uBC1C\uAD74\uC870\uC0AC \uBCF4\uACE0\uC11C",
    "\uBC1C\uAD74\uC870\uC0AC\uBCF4\uACE0\uC11C",
    "\uD589\uC815\uC815\uBCF4",
    "\uBC1C\uAC04\uC790\uB8CC",
    "\uBCF8\uBB38",
    "\uC5F0\uAD6C\uC131\uACFC",
    "\uAD6D\uAC00\uC720\uC0B0 \uC9C0\uC2DD\uC774\uC74C"
  ]);

  const REPORT_TITLE_REJECT_PATTERNS = [
    /\uC870\uC0AC\s*\uC2DC\uB3C4.*\uC81C\uCD9C\s*\uB144\uB3C4/,
    /\uC11C\uC6B8\s+\uBD80\uC0B0\s+\uB300\uAD6C/,
    /2026\s+2025\s+2024\s+2023/
  ];

  const AGENCY_REJECT_PATTERNS = [
    /\uAD6D\uAC00\uC720\uC0B0\s*\uD611\uC5C5\uD3EC\uD138/,
    /\uC9C1\uC811\s*\uC785\uB825/,
    /\uC790\uB3D9\s*\uC5F0\uACC4\s*\uACF5\uAC1C/,
    /\uAD81\uAE08\uD558\uC2E0\s*\uC0AC\uD56D/,
    /\uBB38\uC758\uD558\uC2DC\uAE30\s*\uBC14\uB78D\uB2C8\uB2E4/,
    /\uAC01\s*\uBC1C\uAC04\uAE30\uAD00/
  ];

  const EMINWON_DOWNLOAD_PATTERNS = {
    allText: /\uC804\uCCB4\s*(\uB2E4\uC6B4\uB85C\uB4DC|\uB2E4\uC6B4|\uB0B4\uB824\uBC1B\uAE30)|\uBAA8\uB450\s*(\uB2E4\uC6B4\uB85C\uB4DC|\uB2E4\uC6B4|\uB0B4\uB824\uBC1B\uAE30)/i,
    allSource: /\b(allDown|all_down|down_all|downloadAll|allDownload|allFileDown|fn_all_download|fn_download_all|fn_file_all_down|ZipDownload|fileZip|zipDown)\b/i,
    downloadText: /\uC120\uD0DD\s*(\uB2E4\uC6B4\uB85C\uB4DC|\uB2E4\uC6B4|\uB0B4\uB824\uBC1B\uAE30)|(?:^|\s)(\uB2E4\uC6B4\uB85C\uB4DC|\uB0B4\uB824\uBC1B\uAE30)(?:\s|$)/i,
    downloadSource: /\b(downloadFile|fileDownload|fn_file_download)\b/i
  };

  function parseJsCallArgs(source, functionName) {
    const text = String(source || "");
    const start = text.indexOf(`${functionName}(`);
    if (start < 0) {
      return [];
    }

    const args = [];
    let current = "";
    let quote = "";
    let escaped = false;
    let depth = 0;

    for (let index = start + functionName.length + 1; index < text.length; index += 1) {
      const char = text[index];

      if (quote) {
        if (escaped) {
          current += char;
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = "";
        } else {
          current += char;
        }
        continue;
      }

      if (char === "'" || char === "\"") {
        quote = char;
        continue;
      }

      if (char === "(") {
        depth += 1;
        current += char;
        continue;
      }

      if (char === ")") {
        if (depth === 0) {
          args.push(normalizeSpaces(current));
          break;
        }
        depth -= 1;
        current += char;
        continue;
      }

      if (char === "," && depth === 0) {
        args.push(normalizeSpaces(current));
        current = "";
        continue;
      }

      current += char;
    }

    return args.map((arg) => decodeHtmlEntities(arg));
  }

  function extractFilenameFromUrl(url) {
    if (!url) {
      return "";
    }
    const helper = global.ArchReportFilename;
    if (helper && helper.filenameFromUrl) {
      return helper.filenameFromUrl(url);
    }
    const withoutQuery = String(url).split(/[?#]/)[0];
    try {
      return decodeURIComponent(withoutQuery.split("/").pop() || "");
    } catch (_error) {
      return withoutQuery.split("/").pop() || "";
    }
  }

  function extractYearFromText(text) {
    const source = normalizeSpaces(text);
    const labeled = source.match(/(?:발행년도|발행연도|제작년도|발간년도|발간연도)\s*[:：]?\s*(\d{4})\s*년?/);
    if (labeled) {
      return labeled[1];
    }
    return "";
  }

  function extractAgencyFromText(text) {
    const source = normalizeSpaces(text);
    const labeled = source.match(/(?:발행기관|저작권자|생산자|발간기관|조사기관)\s*[:：]?\s*([^|•\n\r]+?)(?=\s+(?:발행년도|발행연도|형태사항|저작권자|초록|목차|보고서|첨부파일|등록일|조회수)\b|$)/);
    if (labeled) {
      const candidate = normalizeSpaces(labeled[1]);
      if (!candidate ||
          candidate.length > 80 ||
          AGENCY_REJECT_PATTERNS.some((pattern) => pattern.test(candidate))) {
        return "";
      }
      const agencyName = candidate.match(/^(.+?(?:연구소|연구원|센터|재단|기관|협회|대학교|박물관|국가유산진흥원|국가유산청))/);
      const agency = normalizeSpaces((agencyName && agencyName[1]) || candidate);
      if (AGENCY_REJECT_PATTERNS.some((pattern) => pattern.test(agency))) {
        return "";
      }
      return agency;
    }
    return "";
  }

  function valueAfterHeader(header) {
    if (!header || !header.parentElement) {
      return "";
    }
    let sibling = header.nextElementSibling;
    while (sibling) {
      if (/^td$/i.test(sibling.tagName)) {
        return normalizeSpaces(sibling.textContent);
      }
      sibling = sibling.nextElementSibling;
    }
    return "";
  }

  function extractTableFactsFromDocument(doc) {
    const facts = {};
    if (!doc) {
      return facts;
    }

    const labelMap = {
      허가번호: "permitNumber",
      보고서명: "reportTitle",
      "유적명(사업명)": "siteName",
      발간기관: "agency",
      발행기관: "agency",
      저작권자: "agency",
      제출일: "submittedDate",
      "조사 시도": "province",
      "조사 시군구": "district"
    };

    for (const header of Array.from(doc.querySelectorAll("th, dt"))) {
      const label = normalizeSpaces(header.textContent);
      const key = labelMap[label];
      if (!key) {
        continue;
      }
      let value = valueAfterHeader(header);
      if (!value && /^dt$/i.test(header.tagName)) {
        value = normalizeSpaces(header.nextElementSibling && header.nextElementSibling.textContent);
      }
      if (value) {
        facts[key] = value;
      }
    }

    if (facts.submittedDate && !facts.year) {
      const year = facts.submittedDate.match(/\d{4}/);
      facts.year = year ? year[0] : "";
    }

    return facts;
  }

  function parseRaonUploadedFiles(source) {
    const files = [];
    const text = String(source || "");
    const addFilePattern = /RAONKUPLOAD\.AddUploadedFile\(\s*'([^']*)'\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/g;
    let match;
    while ((match = addFilePattern.exec(text))) {
      files.push({
        rowIndex: match[1],
        fileTitle: decodeHtmlEntities(match[2]),
        encodedId: match[3],
        fileSize: match[4]
      });
    }

    const fileNamePattern = /"fileExtnNm"\s*:\s*"([^"]+\.pdf)"/g;
    while ((match = fileNamePattern.exec(text))) {
      const fileTitle = decodeHtmlEntities(match[1]);
      if (!files.some((file) => file.fileTitle === fileTitle)) {
        files.push({ fileTitle });
      }
    }

    return files;
  }

  function stripPdfExtension(value) {
    const helper = global.ArchReportFilename;
    if (helper && helper.stripPdfExtension) {
      return helper.stripPdfExtension(value);
    }
    return String(value || "").replace(/\.pdf$/i, "");
  }

  function cleanupReportTitleCandidate(value) {
    return normalizeSpaces(stripPdfExtension(value)
      .replace(/\s*(?:보고서)?\s*[-_]\s*(?:\d+|별지|부록.*|첨부.*)$/i, "")
      .replace(/\s+보고서\s*(?:\d+|별지|부록.*|첨부.*)$/i, "")
      .replace(/\s+(?:제\s*)?\d+\s*권(?:\([^)]*\))?$/i, ""));
  }

  function commonPrefix(values) {
    if (!values.length) {
      return "";
    }
    let prefix = values[0];
    for (const value of values.slice(1)) {
      while (prefix && !value.startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
      }
      if (!prefix) {
        return "";
      }
    }
    return normalizeSpaces(prefix.replace(/[-_\s]+$/g, ""));
  }

  function deriveReportTitleFromUploadedFiles(files) {
    const candidates = (files || [])
      .map((file) => cleanupReportTitleCandidate(file.fileTitle || ""))
      .filter(Boolean);
    if (candidates.length === 0) {
      return "";
    }

    const unique = Array.from(new Set(candidates));
    if (unique.length === 1) {
      return unique[0];
    }

    const prefix = commonPrefix(unique);
    return prefix.length >= 4 ? cleanupReportTitleCandidate(prefix) : unique[0];
  }

  function extractEminwonContextFromDocument(doc) {
    const facts = extractTableFactsFromDocument(doc);
    const scripts = Array.from(doc.querySelectorAll("script"))
      .map((script) => script.textContent || "")
      .join("\n");
    const files = parseRaonUploadedFiles(scripts);
    const firstFile = files[0] || {};
    const reportTitle = facts.reportTitle || deriveReportTitleFromUploadedFiles(files);

    if (!reportTitle) {
      return null;
    }

    return Object.assign({}, facts, {
      reportTitle,
      sourceKind: "e-minwon",
      fileTitle: firstFile.fileTitle || "",
      originalFilename: firstFile.fileTitle || "",
      attachmentTitle: ""
    });
  }

  function extractEminwonContextsFromDocument(doc) {
    const facts = extractTableFactsFromDocument(doc);
    const scripts = Array.from(doc.querySelectorAll("script"))
      .map((script) => script.textContent || "")
      .join("\n");
    const files = parseRaonUploadedFiles(scripts);
    const reportTitle = facts.reportTitle || deriveReportTitleFromUploadedFiles(files);

    if (!reportTitle) {
      return [];
    }

    if (files.length === 0) {
      return [Object.assign({}, facts, {
        reportTitle,
        sourceKind: "e-minwon",
        fileTitle: "",
        originalFilename: "",
        attachmentTitle: "",
        sequenceNumber: ""
      })];
    }

    return files.map((file, index) => {
      let sequenceNumber = "";
      if (files.length > 1) {
        sequenceNumber = String(index + 1);
      }
      return Object.assign({}, facts, {
        reportTitle,
        sourceKind: "e-minwon",
        fileTitle: file.fileTitle || "",
        originalFilename: file.fileTitle || "",
        attachmentTitle: "",
        sequenceNumber: sequenceNumber
      });
    });
  }

  function extractReportTitleFromDocument(doc) {
    if (!doc) {
      return "";
    }

    const facts = extractTableFactsFromDocument(doc);
    if (facts && facts.reportTitle) {
      return facts.reportTitle;
    }

    function isUsableReportTitle(text) {
      const normalized = normalizeSpaces(text);
      return normalized.length >= 4 &&
        normalized.length <= 120 &&
        !REPORT_TITLE_REJECT_EXACT.has(normalized) &&
        !REPORT_TITLE_REJECT_PATTERNS.some((pattern) => pattern.test(normalized));
    }

    for (const selector of REPORT_TITLE_SELECTOR_CANDIDATES) {
      const elements = Array.from(doc.querySelectorAll(selector));
      for (const element of elements) {
        const text = normalizeSpaces(element.textContent);
        if (isUsableReportTitle(text)) {
          return text;
        }
      }
    }

    const metaTitle = doc.querySelector("meta[property='og:title'], meta[name='title']");
    const title = normalizeSpaces((metaTitle && metaTitle.content) || doc.title || "");
    const cleaned = normalizeSpaces(title.split("|")[0].replace(/국가유산포털|국가유산 지식이음/g, ""));
    return isUsableReportTitle(cleaned) ? cleaned : "";
  }

  function getControlSource(control) {
    if (!control) {
      return "";
    }
    const href = control.getAttribute && control.getAttribute("href");
    const onclick = control.getAttribute && control.getAttribute("onclick");
    return `${href || ""} ${onclick || ""}`;
  }

  function controlSearchText(control) {
    if (!control) {
      return "";
    }
    let text = [
      control.textContent || "",
      control.value || "",
      control.getAttribute && control.getAttribute("title"),
      control.getAttribute && control.getAttribute("alt"),
      control.getAttribute && control.getAttribute("class"),
      control.getAttribute && control.getAttribute("id")
    ].join(" ");
    const images = control.querySelectorAll ? control.querySelectorAll("img") : [];
    for (const img of images) {
      text += " " + [
        img.getAttribute("alt"),
        img.getAttribute("title"),
        img.getAttribute("src")
      ].join(" ");
    }
    return normalizeSpaces(text);
  }

  function classifyEminwonDownloadControl(control) {
    const text = controlSearchText(control);
    const source = getControlSource(control);
    const combined = `${text} ${source}`;

    if (
      EMINWON_DOWNLOAD_PATTERNS.allText.test(text) ||
      EMINWON_DOWNLOAD_PATTERNS.allSource.test(combined)
    ) {
      return "all";
    }

    if (
      EMINWON_DOWNLOAD_PATTERNS.downloadText.test(text) ||
      EMINWON_DOWNLOAD_PATTERNS.downloadSource.test(source)
    ) {
      return "download";
    }

    return "";
  }

  function chooseEminwonDownloadTargetIndexes(fileCount, checkedIndexes, triggerKind) {
    const count = Number(fileCount) || 0;
    if (count <= 1) {
      return [];
    }

    if (triggerKind === "all") {
      return Array.from({ length: count }, (_value, index) => index);
    }

    if (triggerKind === "download") {
      const selected = Array.from(new Set((checkedIndexes || [])
        .map((index) => Number(index))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < count)));
      return selected.length > 1 ? selected : [];
    }

    return [];
  }

  function parseDownloadControl(control) {
    if (!control) {
      return null;
    }

    const dataset = control.dataset || {};
    const source = getControlSource(control);
    const directUrl = dataset.url || "";
    const directFilename = dataset.filename || "";

    if (directUrl || directFilename || source.includes("fn_getDownLode")) {
      const args = parseJsCallArgs(source, "fn_getDownLode");
      const downloadUrl = directUrl || args[0] || "";
      const originalFilename = directFilename || extractFilenameFromUrl(downloadUrl);
      return {
        sourceKind: "heritage",
        downloadUrl,
        originalFilename,
        fileTitle: originalFilename,
        sequenceNumber: dataset.info || ""
      };
    }

    if (source.includes("fnOriFileDownload") || source.includes("fnFileDownload")) {
      const args = parseJsCallArgs(source, source.includes("fnOriFileDownload") ? "fnOriFileDownload" : "fnFileDownload");
      const url = args[0] || "";
      const fileIdx = args[1] || "";
      const menuIdx = args[2] || "";
      const item = control.closest && control.closest("li");
      const nearbyText = normalizeSpaces(item ? item.textContent : control.textContent);
      const titleText = control.getAttribute && control.getAttribute("title");
      const bracketTitle = String(titleText || "").match(/\[([^\]]+\.pdf)\]/i);
      const pdfText = nearbyText.match(/([^\n\r]+?\.pdf)\b/i);
      const fileTitle = normalizeSpaces((bracketTitle && bracketTitle[1]) || (pdfText && pdfText[1]) || "");

      return {
        sourceKind: "nrich",
        downloadUrl: url,
        fileIdx,
        menuIdx,
        originalFilename: fileTitle,
        fileTitle,
        sequenceNumber: ""
      };
    }

    return null;
  }

  function downloadIdentity(controlData) {
    if (!controlData) {
      return "";
    }

    const stableParts = [
      controlData.sourceKind,
      controlData.fileIdx,
      controlData.menuIdx,
      controlData.downloadUrl,
      controlData.originalFilename,
      controlData.fileTitle
    ]
      .map(normalizeSpaces)
      .filter(Boolean);

    return normalizeComparable(stableParts.join("|"));
  }

  function inferSequenceNumberForDownload(controlData, siblingControlDataList) {
    if (!controlData) {
      return "";
    }

    if (controlData.sequenceNumber) {
      return normalizeSpaces(controlData.sequenceNumber);
    }

    const targetIdentity = downloadIdentity(controlData);
    if (!targetIdentity || !Array.isArray(siblingControlDataList)) {
      return "";
    }

    const seen = new Set();
    const distinctSiblings = [];
    siblingControlDataList.forEach((sibling) => {
      if (!sibling || sibling.sourceKind !== controlData.sourceKind) {
        return;
      }
      const identity = downloadIdentity(sibling);
      if (!identity || seen.has(identity)) {
        return;
      }
      seen.add(identity);
      distinctSiblings.push(identity);
    });

    if (distinctSiblings.length <= 1) {
      return "";
    }

    const index = distinctSiblings.indexOf(targetIdentity);
    return index >= 0 ? String(index + 1) : "";
  }

  function isDownloadControl(control) {
    if (!control) {
      return false;
    }
    const source = getControlSource(control);
    const text = controlSearchText(control);

    return Boolean(
      (control.dataset && (control.dataset.url || control.dataset.filename)) ||
      source.includes("fn_getDownLode") ||
      source.includes("fnOriFileDownload") ||
      source.includes("fnFileDownload") ||
      source.includes("fn_file_download") ||
      source.includes("downloadFile") ||
      source.includes("fileDownload") ||
      (text.includes("다운로드") && (source.includes("includeFileDownLoad") || source.includes("download") || source.includes("file")))
    );
  }

  const api = {
    chooseEminwonDownloadTargetIndexes,
    classifyEminwonDownloadControl,
    controlSearchText,
    decodeHtmlEntities,
    downloadIdentity,
    deriveReportTitleFromUploadedFiles,
    extractAgencyFromText,
    extractEminwonContextFromDocument,
    extractEminwonContextsFromDocument,
    extractFilenameFromUrl,
    extractReportTitleFromDocument,
    extractTableFactsFromDocument,
    extractYearFromText,
    inferSequenceNumberForDownload,
    isDownloadControl,
    normalizeSpaces,
    parseDownloadControl,
    parseJsCallArgs,
    parseRaonUploadedFiles,
    stripTags
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ArchReportExtractors = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
