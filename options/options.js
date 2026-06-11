(function initOptionsPage() {
  "use strict";

  const STORAGE_KEY = "archReportSettings";
  const filename = globalThis.ArchReportFilename;

  const citationTemplate = filename.clone(filename.DEFAULT_TEMPLATE);
  const titleTemplate = [
    { kind: "field", value: "reportTitle" }
  ];
  const archiveTemplate = [
    { kind: "field", value: "agency" },
    { kind: "separator", value: "space" },
    { kind: "field", value: "year" },
    { kind: "separator", value: "space" },
    { kind: "field", value: "reportTitle" }
  ];
  const permitTemplate = [
    { kind: "field", value: "permitNumber" },
    { kind: "separator", value: "space" },
    { kind: "field", value: "agency" },
    { kind: "separator", value: "commaSpace" },
    { kind: "field", value: "year" },
    { kind: "separator", value: "commaSpace" },
    { kind: "field", value: "reportTitle" }
  ];

  const presets = [
    {
      id: "citation",
      label: "참고문헌식",
      description: "전북문화재연구원, 2009, 정읍 고부구읍성",
      template: citationTemplate
    },
    {
      id: "title",
      label: "제목 중심",
      description: "정읍 고부구읍성",
      template: titleTemplate
    },
    {
      id: "archive",
      label: "기관별 정리",
      description: "전북문화재연구원 2009 정읍 고부구읍성",
      template: archiveTemplate
    },
    {
      id: "permit",
      label: "허가번호 포함",
      description: "2024-0607 전북문화재연구원, 2009, 정읍 고부구읍성",
      template: permitTemplate
    }
  ];

  const fieldPalette = [
    { kind: "field", value: "reportTitle" },
    { kind: "field", value: "attachmentTitle" },
    { kind: "field", value: "year" },
    { kind: "field", value: "agency" },
    { kind: "field", value: "permitNumber" },
    { kind: "field", value: "siteName" },
    { kind: "field", value: "submittedDate" },
    { kind: "field", value: "province" },
    { kind: "field", value: "district" },
    { kind: "field", value: "originalFilename" },
    { kind: "field", value: "sequenceNumber" }
  ];

  const separatorPalette = [
    { kind: "separator", value: "space", label: "공백" },
    { kind: "separator", value: "commaSpace", label: ", " },
    { kind: "separator", value: "underscore", label: "_" },
    { kind: "separator", value: "hyphen", label: "-" },
    { kind: "separator", value: "openParen", label: "(" },
    { kind: "separator", value: "closeParen", label: ")" }
  ];

  const sampleMain = {
    reportTitle: "정읍 고부구읍성",
    fileTitle: "정읍 고부구읍성.pdf",
    originalFilename: "정읍 고부구읍성.pdf",
    year: "2009",
    agency: "전북문화재연구원",
    permitNumber: "2009-0123",
    siteName: "정읍 고부구읍성",
    submittedDate: "2009-12-18",
    province: "전북",
    district: "정읍시"
  };

  const sampleAttachment = {
    reportTitle: "경주 월성 시·발굴 조사 보고서",
    fileTitle: "경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf",
    originalFilename: "경주 월성 시ㆍ발굴조사보고서 1권(시굴조사).pdf",
    year: "2021",
    agency: "국립경주문화유산연구소",
    permitNumber: "2021-0001",
    siteName: "경주 월성",
    submittedDate: "2022-02-08",
    province: "경북",
    district: "경주시",
    sequenceNumber: "1"
  };

  let settings = filename.mergeSettings();
  let currentContext = sampleMain;
  let draggedRecipeIndex = null;
  let dragInsertIndex = null;
  let insertMarker = null;

  const els = {};

  function tokenLabel(token) {
    if (token.kind === "field") {
      return filename.FIELD_LABELS[token.value] || token.value;
    }
    if (token.kind === "separator") {
      if (token.value === "custom") {
        return token.text || "";
      }
      return separatorPalette.find((item) => item.value === token.value)?.label || token.value;
    }
    return token.value || token.text || "";
  }

  function tokenClass(token) {
    if (token.kind === "field") {
      return "field";
    }
    if (token.kind === "separator") {
      return "separator";
    }
    return "text";
  }

  function cloneToken(token) {
    return JSON.parse(JSON.stringify(token));
  }

  function templatesEqual(left, right) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
  }

  function save() {
    settings = filename.mergeSettings(settings);
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
      return;
    }
    els.status.textContent = "저장 중";
    chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => {
      els.status.textContent = chrome.runtime.lastError ? "저장 실패" : "저장됨";
    });
  }

  function updatePreview() {
    els.previewMain.value = filename.renderFilename(currentContext, settings);
    els.previewAttachment.value = filename.renderFilename(sampleAttachment, settings);
  }

  function addToken(token, index) {
    const next = cloneToken(token);
    if (Number.isInteger(index)) {
      settings.template.splice(index, 0, next);
    } else {
      settings.template.push(next);
    }
    renderRecipe();
    renderPresets();
    save();
  }

  function moveToken(fromIndex, toIndex) {
    if (fromIndex === null || fromIndex < 0 || fromIndex >= settings.template.length) {
      return;
    }
    const [token] = settings.template.splice(fromIndex, 1);
    const adjusted = fromIndex < toIndex ? toIndex - 1 : toIndex;
    settings.template.splice(Math.max(0, adjusted), 0, token);
    renderRecipe();
    renderPresets();
    save();
  }

  function removeToken(index) {
    settings.template.splice(index, 1);
    renderRecipe();
    renderPresets();
    save();
  }

  function applyPreset(preset) {
    settings.template = filename.clone(preset.template);
    renderRecipe();
    renderPresets();
    save();
  }

  function makeChip(token, options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip ${tokenClass(token)}`;
    chip.draggable = true;
    chip.textContent = tokenLabel(token);

    chip.addEventListener("click", () => {
      if (options.palette) {
        addToken(token);
      }
    });

    chip.addEventListener("dragstart", (event) => {
      chip.classList.add("dragging");
      if (options.palette) {
        event.dataTransfer.setData("application/json", JSON.stringify(token));
        event.dataTransfer.effectAllowed = "copy";
        return;
      }
      draggedRecipeIndex = options.index;
      event.dataTransfer.effectAllowed = "move";
    });

    chip.addEventListener("dragend", () => {
      chip.classList.remove("dragging");
      clearInsertMarker();
      draggedRecipeIndex = null;
    });

    if (!options.palette) {
      const remove = document.createElement("span");
      remove.className = "chip-remove";
      remove.textContent = "x";
      remove.setAttribute("aria-label", "삭제");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeToken(options.index);
      });
      chip.appendChild(remove);
    }

    return chip;
  }

  function clearInsertMarker() {
    if (insertMarker && insertMarker.parentElement) {
      insertMarker.parentElement.removeChild(insertMarker);
    }
    insertMarker = null;
    dragInsertIndex = null;
    els.recipeList.classList.remove("drag-over");
  }

  function recipeChips() {
    return Array.from(els.recipeList.querySelectorAll(":scope > .chip"));
  }

  function getInsertIndex(event) {
    const chips = recipeChips();
    if (chips.length === 0) {
      return 0;
    }

    let best = { distance: Number.POSITIVE_INFINITY, index: chips.length };
    chips.forEach((chip, index) => {
      const rect = chip.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const beforeDistance = Math.hypot(event.clientX - rect.left, event.clientY - centerY);
      const afterDistance = Math.hypot(event.clientX - rect.right, event.clientY - centerY);
      if (beforeDistance < best.distance) {
        best = { distance: beforeDistance, index };
      }
      if (afterDistance < best.distance) {
        best = { distance: afterDistance, index: index + 1 };
      }
    });

    return best.index;
  }

  function showInsertMarker(index) {
    if (!insertMarker) {
      insertMarker = document.createElement("span");
      insertMarker.className = "insert-marker";
      insertMarker.setAttribute("aria-hidden", "true");
    }

    const chips = recipeChips();
    const target = chips[index] || null;
    if (target !== insertMarker.nextSibling) {
      els.recipeList.insertBefore(insertMarker, target);
    }
    dragInsertIndex = index;
    els.recipeList.classList.add("drag-over");
  }

  function renderPresets() {
    els.presetList.textContent = "";
    for (const preset of presets) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preset-button";
      if (templatesEqual(settings.template, preset.template)) {
        button.classList.add("active");
      }
      button.innerHTML = `<strong>${preset.label}</strong><span>${preset.description}</span>`;
      button.addEventListener("click", () => applyPreset(preset));
      els.presetList.appendChild(button);
    }
  }

  function renderPalette() {
    els.fieldPalette.textContent = "";
    els.separatorPalette.textContent = "";
    for (const token of fieldPalette) {
      els.fieldPalette.appendChild(makeChip(token, { palette: true }));
    }
    for (const token of separatorPalette) {
      els.separatorPalette.appendChild(makeChip(token, { palette: true }));
    }
  }

  function renderRecipe() {
    clearInsertMarker();
    els.recipeList.textContent = "";
    settings.template.forEach((token, index) => {
      els.recipeList.appendChild(makeChip(token, { index }));
    });
    updatePreview();
  }

  function setupRecipeDrop() {
    els.recipeList.addEventListener("dragover", (event) => {
      event.preventDefault();
      showInsertMarker(getInsertIndex(event));
    });

    els.recipeList.addEventListener("dragleave", (event) => {
      if (!els.recipeList.contains(event.relatedTarget)) {
        clearInsertMarker();
      }
    });

    els.recipeList.addEventListener("drop", (event) => {
      event.preventDefault();
      const index = Number.isInteger(dragInsertIndex) ? dragInsertIndex : settings.template.length;
      const paletteToken = event.dataTransfer.getData("application/json");
      clearInsertMarker();
      if (paletteToken) {
        addToken(JSON.parse(paletteToken), index);
        return;
      }
      moveToken(draggedRecipeIndex, index);
      draggedRecipeIndex = null;
    });
  }

  function bindControls() {
    els.enabledToggle.addEventListener("change", () => {
      settings.enabled = els.enabledToggle.checked;
      save();
    });

    els.resetButton.addEventListener("click", () => {
      settings = filename.mergeSettings({
        enabled: true,
        template: filename.clone(filename.DEFAULT_TEMPLATE)
      });
      els.enabledToggle.checked = settings.enabled;
      renderRecipe();
      renderPresets();
      save();
    });

    els.addCustomButton.addEventListener("click", () => {
      const text = filename.normalizeSpaces(els.customText.value);
      if (!text) {
        return;
      }
      addToken({ kind: "text", value: text });
      els.customText.value = "";
    });

    els.customText.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.addCustomButton.click();
      }
    });
  }

  function cacheElements() {
    els.enabledToggle = document.getElementById("enabled-toggle");
    els.presetList = document.getElementById("preset-list");
    els.recipeList = document.getElementById("recipe-list");
    els.fieldPalette = document.getElementById("field-palette");
    els.separatorPalette = document.getElementById("separator-palette");
    els.previewMain = document.getElementById("preview-main");
    els.previewAttachment = document.getElementById("preview-attachment");
    els.resetButton = document.getElementById("reset-button");
    els.customText = document.getElementById("custom-text");
    els.addCustomButton = document.getElementById("add-custom-button");
    els.status = document.getElementById("save-status");
  }

  function setupCitation() {
    const citationInput = document.getElementById("citation-input");
    const copyBtn = document.getElementById("copy-citation-btn");
    const unusableMetadataPattern = /직접입력|자동\s*연계\s*공개|궁금하신\s*사항|문의하시기\s*바랍니다|국가유산\s*협업포털|각\s*발간기관|조사시도\s*시도|서울\s+부산\s+대구/;
    const unusableCompactTitles = new Set(["발굴조사보고서", "행정정보"]);
    
    if (!citationInput || !copyBtn) return;

    const cleanMetadataValue = (value) => {
      const normalized = filename.normalizeSpaces(value);
      return unusableMetadataPattern.test(normalized) ? "" : normalized;
    };
    
    const formatCitation = (meta) => {
      const parts = [];
      const agency = cleanMetadataValue(meta && meta.agency);
      const year = cleanMetadataValue(meta && meta.year);
      const reportTitle = cleanMetadataValue(meta && meta.reportTitle);

      if (agency) {
        parts.push(agency);
      }
      if (year) {
        parts.push(year);
      }
      if (reportTitle) {
        parts.push(`『${reportTitle}』`);
      }
      return parts.join(", ");
    };

    const isUsableReportMetadata = (meta) => {
      const title = filename.normalizeSpaces(meta && meta.reportTitle);
      const compactTitle = title.replace(/\s+/g, "");
      return Boolean(title) &&
        title.length <= 120 &&
        !unusableCompactTitles.has(compactTitle) &&
        !unusableMetadataPattern.test(title) &&
        !unusableMetadataPattern.test(filename.normalizeSpaces(meta && meta.agency));
    };

    const showCopiedState = () => {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = "복사됨!";
      copyBtn.style.background = "#15803d";
      copyBtn.style.borderColor = "#15803d";
      setTimeout(() => {
        copyBtn.textContent = originalText;
        copyBtn.style.background = "";
        copyBtn.style.borderColor = "";
      }, 1500);
    };

    copyBtn.addEventListener("click", () => {
      const value = citationInput.value;
      if (!value) {
        return;
      }
      navigator.clipboard.writeText(value)
        .then(showCopiedState)
        .catch((err) => {
          console.error("Failed to copy text: ", err);
        });
    });

    if (typeof chrome === "undefined" || !chrome.tabs) {
      citationInput.value = "(재)한울문화유산연구원, 2026, 『울산 서하리 240-1번지 유적』";
      copyBtn.disabled = false;
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.id) {
        citationInput.value = "";
        citationInput.placeholder = "활성 탭이 없습니다.";
        copyBtn.disabled = true;
        return;
      }

      const url = activeTab.url || "";
      const isSupported = /heritage\.go\.kr|cha\.go\.kr|khs\.go\.kr|e-minwon\.go\.kr|nrich\.go\.kr/.test(url);
      
      if (!isSupported) {
        citationInput.value = "";
        citationInput.placeholder = "보고서 상세 페이지가 아닙니다.";
        copyBtn.disabled = true;
        return;
      }

      const key = `reportMetadata_${activeTab.id}`;
      chrome.storage.local.get(key, (result) => {
        const cached = result[key];
        
        const applyMetadata = (metadata) => {
          const citationValue = formatCitation(metadata);
          citationInput.value = citationValue;
          copyBtn.disabled = !citationValue;

          // Update current preview context with actual metadata
          currentContext = {
            reportTitle: cleanMetadataValue(metadata.reportTitle),
            fileTitle: cleanMetadataValue(metadata.reportTitle) + ".pdf",
            originalFilename: cleanMetadataValue(metadata.reportTitle) + ".pdf",
            year: cleanMetadataValue(metadata.year),
            agency: cleanMetadataValue(metadata.agency),
            permitNumber: cleanMetadataValue(metadata.permitNumber),
            siteName: cleanMetadataValue(metadata.siteName),
            submittedDate: cleanMetadataValue(metadata.submittedDate),
            province: cleanMetadataValue(metadata.province),
            district: cleanMetadataValue(metadata.district)
          };
          updatePreview();

        };

        const askCurrentTab = () => {
          chrome.tabs.sendMessage(activeTab.id, { type: "get-report-title" }, (response) => {
            if (!chrome.runtime.lastError && isUsableReportMetadata(response)) {
              applyMetadata(response);
              return;
            }
            if (isUsableReportMetadata(cached)) {
              applyMetadata(cached);
              return;
            }
            citationInput.value = "";
            citationInput.placeholder = "보고서 상세 페이지가 아닙니다.";
            copyBtn.disabled = true;
          });
        };

        if (/e-minwon\.go\.kr/.test(url)) {
          askCurrentTab();
        } else if (isUsableReportMetadata(cached)) {
          applyMetadata(cached);
        } else {
          // Fallback: Ask content script directly
          chrome.tabs.sendMessage(activeTab.id, { type: "get-report-title" }, (response) => {
            if (chrome.runtime.lastError || !isUsableReportMetadata(response)) {
              citationInput.value = "";
              citationInput.placeholder = "보고서 상세 페이지가 아닙니다.";
              copyBtn.disabled = true;
              return;
            }
            applyMetadata(response);
          });
        }
      });
    });
  }

  function load() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
      renderPresets();
      renderPalette();
      renderRecipe();
      return;
    }

    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      settings = filename.mergeSettings(result && result[STORAGE_KEY]);
      els.enabledToggle.checked = settings.enabled;
      renderPresets();
      renderPalette();
      renderRecipe();
    });
  }

  function setupTabs() {
    document.body.classList.add("tab-rename-active");

    const tabButtons = document.querySelectorAll(".tab-nav .tab-btn");
    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        tabButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const targetTab = btn.getAttribute("data-tab");
        if (targetTab === "citation") {
          document.body.classList.add("tab-citation-active");
          document.body.classList.remove("tab-rename-active");
        } else if (targetTab === "rename") {
          document.body.classList.add("tab-rename-active");
          document.body.classList.remove("tab-citation-active");
        }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const isPopup = new URLSearchParams(window.location.search).get("mode") === "popup";
    if (isPopup) {
      document.body.classList.add("is-popup");
      setupTabs();
    }
    cacheElements();
    setupRecipeDrop();
    bindControls();
    load();
    setupCitation();
  });
})();
