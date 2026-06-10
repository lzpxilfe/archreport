(function initExtractorModule(global) {
  "use strict";

  function normalizeSpaces(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
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
      const agencyName = candidate.match(/^(.+?(?:연구소|연구원|센터|재단|기관|협회|대학교|박물관|국가유산진흥원|국가유산청))/);
      return normalizeSpaces((agencyName && agencyName[1]) || candidate);
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

  function extractEminwonContextFromDocument(doc) {
    const facts = extractTableFactsFromDocument(doc);
    if (!facts.reportTitle) {
      return null;
    }

    const scripts = Array.from(doc.querySelectorAll("script"))
      .map((script) => script.textContent || "")
      .join("\n");
    const files = parseRaonUploadedFiles(scripts);
    const firstFile = files[0] || {};

    return Object.assign({}, facts, {
      sourceKind: "e-minwon",
      fileTitle: firstFile.fileTitle || "",
      originalFilename: firstFile.fileTitle || "",
      attachmentTitle: ""
    });
  }

  function extractReportTitleFromDocument(doc) {
    if (!doc) {
      return "";
    }

    const rejected = new Set([
      "국가유산 간행물",
      "보고서",
      "발간자료",
      "본문",
      "연구성과",
      "국가유산 지식이음"
    ]);

    const selectors = [
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

    for (const selector of selectors) {
      const elements = Array.from(doc.querySelectorAll(selector));
      for (const element of elements) {
        const text = normalizeSpaces(element.textContent);
        if (text.length >= 4 && !rejected.has(text)) {
          return text;
        }
      }
    }

    const metaTitle = doc.querySelector("meta[property='og:title'], meta[name='title']");
    const title = normalizeSpaces((metaTitle && metaTitle.content) || doc.title || "");
    return normalizeSpaces(title.split("|")[0].replace(/국가유산포털|국가유산 지식이음/g, ""));
  }

  function getControlSource(control) {
    if (!control) {
      return "";
    }
    const href = control.getAttribute && control.getAttribute("href");
    const onclick = control.getAttribute && control.getAttribute("onclick");
    return `${href || ""} ${onclick || ""}`;
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

  function isDownloadControl(control) {
    if (!control) {
      return false;
    }
    const source = getControlSource(control);
    const text = normalizeSpaces(control.textContent || control.getAttribute("title") || "");
    return Boolean(
      (control.dataset && (control.dataset.url || control.dataset.filename)) ||
      source.includes("fn_getDownLode") ||
      source.includes("fnOriFileDownload") ||
      source.includes("fnFileDownload") ||
      (text.includes("다운로드") && source.includes("includeFileDownLoad"))
    );
  }

  const api = {
    decodeHtmlEntities,
    extractAgencyFromText,
    extractEminwonContextFromDocument,
    extractFilenameFromUrl,
    extractReportTitleFromDocument,
    extractTableFactsFromDocument,
    extractYearFromText,
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
