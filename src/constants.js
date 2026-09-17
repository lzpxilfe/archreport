(function initConstantsModule(global) {
  "use strict";

  const APP_TITLE = "\uAD6D\uAC00\uC720\uC0B0 \uBCF4\uACE0\uC11C \uD30C\uC77C\uBA85 \uC124\uC815";

  const MESSAGES = {
    DOWNLOAD_CONTEXT: "arch-report-download-context",
    PAGE_READY: "arch-report-page-ready",
    START_EMINWON_QUEUE: "arch-report-start-eminwon-download-queue",
    EMINWON_CONTEXT_BRIDGE: "arch-report-eminwon-context-bridge",
    EMINWON_CONTEXT_REQUEST: "arch-report-eminwon-context-request",
    EMINWON_QUEUE_BRIDGE: "arch-report-eminwon-download-queue-bridge",
    EMINWON_QUEUE_DOWNLOAD_STARTED: "arch-report-eminwon-queue-download-started",
    REPORT_METADATA_EXTRACTED: "report-metadata-extracted",
    GET_REPORT_TITLE: "get-report-title"
  };

  const HOSTS = {
    HERITAGE: "heritage.go.kr",
    CHA: "cha.go.kr",
    KHS: "khs.go.kr",
    EMINWON: "e-minwon.go.kr",
    NRICH: "nrich.go.kr",
    CIHC: "cihc.or.kr",
    IHA: "iha.go.kr"
  };

  const SOURCES = {
    HERITAGE: "heritage",
    EMINWON: "e-minwon",
    NRICH: "nrich",
    CIHC: "cihc",
    IHA: "iha",
    UNKNOWN: "unknown"
  };

  const TIMING = {
    COPIED_STATE_MS: 1500,
    EMINWON_QUEUE_ACK_TIMEOUT_MS: 10000,
    EMINWON_QUEUE_AFTER_ACK_DELAY_MS: 350,
    EMINWON_QUEUE_CLICK_DELAY_MS: 120,
    EMINWON_CHILD_QUEUE_TIMEOUT_MS: 1200,
    PAGE_INIT_RETRY_DELAYS_MS: [1000, 3000, 6000]
  };

  const ACTION = {
    DISABLED_BADGE_TEXT: "OFF",
    DISABLED_BADGE_COLOR: "#9b5b1c",
    DEFAULT_TITLE: APP_TITLE,
    DISABLED_TITLE: `${APP_TITLE} - \uAEBC\uC9D0`
  };

  // 다른 확장 프로그램(예: 논문 PDF 인용식 파일명)과의 공존을 위한 설정.
  // 학술 DB 호스트와, 다른 확장이 직접 시작한 다운로드에 양보한다.
  const COEXISTENCE = {
    OWN_EXTENSION_NAME: "국가유산 보고서 파일명 정리"
  };

  const sitePolicy = global.DownloadSitePolicy || (typeof require === "function" ? require("./site-policy.js") : null);

  const api = {
    sitePolicy,
    ACTION,
    APP_TITLE,
    COEXISTENCE,
    HOSTS,
    MESSAGES,
    SETTINGS_STORAGE_KEY: "archReportSettings",
    SOURCES,
    TIMING
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ArchReportConstants = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
