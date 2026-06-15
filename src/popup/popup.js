const dom = {
  expandBtn: document.getElementById("expandBtn"),
  recordingToggle: document.getElementById("recordingToggle"),
  runBtn: document.getElementById("runBtn"),
  runUrlInput: document.getElementById("runUrlInput"),
  captureUrlBtn: document.getElementById("captureUrlBtn"),
  azureApiKeyInput: document.getElementById("azureApiKeyInput"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  agentGoalInput: document.getElementById("agentGoalInput"),
  runAgentBtn: document.getElementById("runAgentBtn"),
  uploadPdfBtn: document.getElementById("uploadPdfBtn"),
  testConnectionBtn: document.getElementById("testConnectionBtn"),
  useBackendToggle: document.getElementById("useBackendToggle"),
  backendUrlInput: document.getElementById("backendUrlInput"),
  saveBackendBtn: document.getElementById("saveBackendBtn"),
  pdfFileInput: document.getElementById("pdfFileInput"),
  llmAutoContinueToggle: document.getElementById("llmAutoContinueToggle"),
  attachmentsList: document.getElementById("attachmentsList"),
  addStepBtn: document.getElementById("addStepBtn"),
  pasteStepBtn: document.getElementById("pasteStepBtn"),
  saveBtn: document.getElementById("saveBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFileInput: document.getElementById("importFileInput"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  runConsole: document.getElementById("runConsole"),
  stepsList: document.getElementById("stepsList"),
  stepTemplate: document.getElementById("stepTemplate"),
  filterLabelInput: document.getElementById("filterLabelInput"),
  filterClassInput: document.getElementById("filterClassInput"),
  filterPageObjectInput: document.getElementById("filterPageObjectInput"),
  clearStepFiltersBtn: document.getElementById("clearStepFiltersBtn")
};

let steps = [];
let dragFromIndex = null;
let savedSteps = [];
let runUrl = "";
let savedRunUrl = "";
let attachments = [];
let stepDebugStatus = [];
let activeStepIndex = -1;
let copiedStepText = "";
let stepDatasetStatus = new Map();
let datasetRunStatus = new Map();
let stepFailureEvidence = new Map();
let runHistoryEntries = [];
let stepMetadataPanelKeys = new Set();
let stepFilters = {
  label: "",
  className: "",
  pageObjectName: ""
};
const GHERKIN_TYPES = new Set(["Given", "When", "Then", "And", "But"]);
const SUPPORTED_LOCATOR_STRATEGIES = new Set([
  "text",
  "xpath",
  "data-testid",
  "data-testid-index",
  "aria-label",
  "aria-label-index",
  "id",
  "name",
  "selector"
]);
const CREATE_NEW_LOCATOR_VALUE = "__create_new_locator__";
const CUSTOM_LOCATOR_STRATEGIES = ["xpath", "selector", "text", "data-testid", "aria-label", "id", "name"];
const ASSERTION_TYPES = new Set([
  "exists",
  "visible",
  "textEquals",
  "textContains",
  "valueEquals",
  "attributeEquals",
  "urlContains",
  "titleContains"
]);
const WAIT_CONDITIONS = new Set(["afterDelay", "untilElementVisible"]);

initialize();

async function initialize() {
  const expanded = false;
  document.body.classList.toggle("expanded", expanded);
  if (dom.expandBtn) {
    dom.expandBtn.textContent = expanded ? "Collapse" : "Expand";
  }

  const response = await send({ type: "GET_STEPS" });
  steps = sanitizePopupStepList(Array.isArray(response?.steps) ? response.steps : []);
  savedSteps = sanitizePopupStepList(Array.isArray(response?.savedSteps) ? response.savedSteps : []);
  attachments = Array.isArray(response?.attachments) ? response.attachments : [];
  runHistoryEntries = Array.isArray(response?.runHistory) ? response.runHistory : [];
  runUrl = typeof response?.runUrl === "string" ? response.runUrl : "";
  savedRunUrl = typeof response?.savedRunUrl === "string" ? response.savedRunUrl : "";
  dom.llmAutoContinueToggle.checked = Boolean(response?.llmAutoContinueEnabled);
  dom.useBackendToggle.checked = Boolean(response?.useLlmBackend);
  dom.backendUrlInput.value = typeof response?.llmBackendUrl === "string" ? response.llmBackendUrl : "";
  if (dom.azureApiKeyInput) {
    dom.azureApiKeyInput.value = response?.azureApiKeySet ? "********" : "";
    dom.azureApiKeyInput.dataset.hasSavedKey = response?.azureApiKeySet ? "1" : "0";
  }
  dom.recordingToggle.checked = Boolean(response?.isRecording);
  dom.runUrlInput.value = runUrl;
  renderRunHistoryConsole();
  applyRunSnapshot(response?.runSnapshot);
  render();
  bindEvents();
}

function bindEvents() {
  if (dom.expandBtn) {
    dom.expandBtn.addEventListener("click", () => {
      const nextExpanded = !document.body.classList.contains("expanded");
      document.body.classList.toggle("expanded", nextExpanded);
      dom.expandBtn.textContent = nextExpanded ? "Collapse" : "Expand";
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "RUN_PROGRESS") {
      return;
    }

    const payload = message.payload || {};
    if (payload.type === "start") {
      stepDebugStatus = [];
      stepDatasetStatus = new Map();
      datasetRunStatus = new Map();
      stepFailureEvidence = new Map();
      activeStepIndex = -1;
      render();
      clearRunConsole();
      if (Number.isInteger(payload.totalRuns) && Number.isInteger(payload.totalSteps)) {
        setStatus(`Running ${payload.totalRuns} new incognito window(s) across ${payload.totalSteps} steps.`);
        appendRunConsole(`Run started: ${payload.totalRuns} dataset(s), ${payload.totalSteps} step(s).`);
      }
      return;
    }

    if (payload.type === "active") {
      activeStepIndex = Number.isInteger(payload.index) ? payload.index : -1;
      render();
      return;
    }

    if (payload.type === "result") {
      if (Number.isInteger(payload.index) && payload.status) {
        const existingIndex = stepDebugStatus.findIndex((entry) => entry.index === payload.index);
        const nextEntry = { index: payload.index, status: payload.status, reason: payload.reason || "" };
        if (existingIndex >= 0) {
          stepDebugStatus[existingIndex] = nextEntry;
        } else {
          stepDebugStatus.push(nextEntry);
        }
      }
      render();
      return;
    }

    if (payload.type === "done") {
      stepDatasetStatus = buildDatasetStepStatus(payload.report);
      datasetRunStatus = buildDatasetRunStatus(payload.report);
      stepFailureEvidence = buildStepFailureEvidence(payload.report);
      activeStepIndex = -1;
      render();
      appendRunConsole("Run finished.");
    }
  });

  dom.recordingToggle.addEventListener("change", async () => {
    await send({ type: "SET_RECORDING", payload: { enabled: dom.recordingToggle.checked } });
    setStatus(dom.recordingToggle.checked ? "Recording enabled." : "Recording disabled.");
  });

  dom.clearBtn.addEventListener("click", async () => {
    await send({ type: "CLEAR_STEPS" });
    steps = [];
    runUrl = "";
    savedRunUrl = "";
    stepDebugStatus = [];
    stepDatasetStatus = new Map();
    datasetRunStatus = new Map();
    stepFailureEvidence = new Map();
    dom.runUrlInput.value = "";
    render();
    setStatus("Steps cleared.");
  });

  dom.addStepBtn.addEventListener("click", async () => {
    steps.push(createEmptyStep());
    render();
    await persistSteps();
    setStatus("New step added.");
  });

  if (dom.pasteStepBtn) {
    dom.pasteStepBtn.addEventListener("click", async () => {
      const pastedStep = await readStepFromClipboard();
      if (!pastedStep) {
        setStatus("Clipboard does not contain a valid step JSON.");
        return;
      }

      steps.push(pastedStep);
      render();
      await persistSteps();
      setStatus("Step pasted from clipboard.");
    });
  }

  dom.stepsList.addEventListener("paste", async (event) => {
    const text = event.clipboardData?.getData("text/plain") || "";
    const parsedStep = parseStepFromClipboardText(text);
    if (!parsedStep) {
      return;
    }

    event.preventDefault();

    const targetElement = event.target;
    const targetItem = targetElement instanceof Element ? targetElement.closest(".step-item") : null;
    const targetIndex = targetItem ? Number(targetItem.dataset.index) : steps.length - 1;
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= steps.length) {
      steps.push(parsedStep);
      render();
      await persistSteps();
      setStatus("Step pasted as new row.");
      return;
    }

    const existing = steps[targetIndex] || createEmptyStep();
    const merged = {
      ...parsedStep,
      id: existing.id || parsedStep.id,
      createdAt: existing.createdAt || parsedStep.createdAt || new Date().toISOString()
    };
    steps[targetIndex] = merged;
    render();
    await persistSteps();
    setStatus(`Step pasted into row ${targetIndex + 1}.`);
  });

  dom.runUrlInput.addEventListener("input", async (event) => {
    runUrl = event.target.value;
    await persistSteps();
  });

  if (dom.filterLabelInput) {
    dom.filterLabelInput.addEventListener("input", (event) => {
      stepFilters.label = String(event.target.value || "");
      render();
    });
  }

  if (dom.filterClassInput) {
    dom.filterClassInput.addEventListener("input", (event) => {
      stepFilters.className = String(event.target.value || "");
      render();
    });
  }

  if (dom.filterPageObjectInput) {
    dom.filterPageObjectInput.addEventListener("input", (event) => {
      stepFilters.pageObjectName = String(event.target.value || "");
      render();
    });
  }

  if (dom.clearStepFiltersBtn) {
    dom.clearStepFiltersBtn.addEventListener("click", () => {
      stepFilters = { label: "", className: "", pageObjectName: "" };
      if (dom.filterLabelInput) {
        dom.filterLabelInput.value = "";
      }
      if (dom.filterClassInput) {
        dom.filterClassInput.value = "";
      }
      if (dom.filterPageObjectInput) {
        dom.filterPageObjectInput.value = "";
      }
      render();
    });
  }

  dom.captureUrlBtn.addEventListener("click", async () => {
    const response = await send({ type: "GET_ACTIVE_TAB_URL" });
    if (!response?.ok) {
      setStatus("Could not capture URL.");
      return;
    }

    runUrl = response.url || "";
    dom.runUrlInput.value = runUrl;
    await persistSteps();
    setStatus("URL captured.");
  });

  if (dom.saveApiKeyBtn && dom.azureApiKeyInput) {
    dom.saveApiKeyBtn.addEventListener("click", async () => {
      const nextValue = dom.azureApiKeyInput.value.trim();
      const hasSavedKey = dom.azureApiKeyInput.dataset.hasSavedKey === "1";
      const apiKey = nextValue === "********" && hasSavedKey ? "__UNCHANGED__" : nextValue;

      const response = await send({ type: "SAVE_AZURE_API_KEY", payload: { apiKey } });
      if (!response?.ok) {
        setStatus(`API key save failed: ${response?.error || "unknown"}`);
        return;
      }

      if (response.keySaved) {
        dom.azureApiKeyInput.value = "********";
        dom.azureApiKeyInput.dataset.hasSavedKey = "1";
        setStatus("API key saved.");
        return;
      }

      dom.azureApiKeyInput.value = "";
      dom.azureApiKeyInput.dataset.hasSavedKey = "0";
      setStatus("API key cleared.");
    });
  }

  dom.saveBackendBtn.addEventListener("click", async () => {
    const useBackend = Boolean(dom.useBackendToggle.checked);
    const backendUrl = dom.backendUrlInput.value.trim();
    const response = await send({
      type: "SAVE_LLM_BACKEND_CONFIG",
      payload: { useBackend, backendUrl }
    });

    if (!response?.ok) {
      setStatus(`Backend save failed: ${response?.error || "unknown"}`);
      return;
    }

    setStatus(useBackend ? "Secure backend mode enabled." : "Direct API key mode enabled.");
  });

  dom.llmAutoContinueToggle.addEventListener("change", async () => {
    const response = await send({
      type: "SET_LLM_AUTO_CONTINUE",
      payload: { enabled: dom.llmAutoContinueToggle.checked }
    });

    if (!response?.ok) {
      setStatus("Could not update auto-continue setting.");
      return;
    }

    setStatus(dom.llmAutoContinueToggle.checked ? "LLM mandatory-field continuation enabled." : "LLM mandatory-field continuation disabled.");
  });

  dom.uploadPdfBtn.addEventListener("click", () => {
    dom.pdfFileInput.click();
  });

  dom.runAgentBtn.addEventListener("click", async () => {
    const goal = dom.agentGoalInput.value.trim();
    if (!goal) {
      setStatus("Enter a goal before running the agent.");
      return;
    }

    setStatus("LLM agent is running...");
    const response = await send({ type: "RUN_LLM_AGENT", payload: { goal } });
    if (!response?.ok) {
      setStatus(`Agent failed: ${response?.error || "unknown"}`);
      return;
    }

    const completed = response.result?.status === "completed";
    const stepCount = Number(response.result?.stepsExecuted || 0);
    setStatus(completed ? `Agent completed in ${stepCount} step(s).` : `Agent stopped after ${stepCount} step(s).`);
  });

  if (dom.testConnectionBtn) {
    dom.testConnectionBtn.addEventListener("click", async () => {
      setStatus("Testing LLM connection...");
      const response = await send({ type: "TEST_LLM_CONNECTION" });
      if (!response?.ok) {
        setStatus(`Connection failed: ${response?.error || "unknown"}`);
        return;
      }

      const mode = String(response?.mode || "");
      const version = String(response?.apiVersion || "");
      if (version) {
        setStatus(`Connection OK (${mode}, ${version}).`);
        return;
      }

      setStatus(`Connection OK (${mode}).`);
    });
  }

  dom.pdfFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const pdfBase64 = arrayBufferToBase64(buffer);
      const response = await send({
        type: "EXTRACT_TEST_DATA_FROM_PDF",
        payload: {
          fileName: file.name,
          pdfBase64,
          sizeBytes: Number(file.size) || 0,
          contentType: String(file.type || "application/pdf")
        }
      });

      if (!response?.ok) {
        setStatus(`PDF extraction failed: ${response?.error || "unknown"}`);
        return;
      }

      const refreshed = await send({ type: "GET_STEPS" });
      steps = Array.isArray(refreshed?.steps) ? refreshed.steps : steps;
      savedSteps = Array.isArray(refreshed?.savedSteps) ? refreshed.savedSteps : savedSteps;
      attachments = Array.isArray(refreshed?.attachments) ? refreshed.attachments : attachments;
      render();

      if (response.attachmentStored === false) {
        setStatus(`PDF extracted. ${response.mappedFields || 0} step values updated. Attachment storage warning.`);
        return;
      }

      setStatus(`PDF extracted and stored. ${response.mappedFields || 0} step values updated.`);
    } catch {
      setStatus("Could not read the selected PDF.");
    } finally {
      dom.pdfFileInput.value = "";
    }
  });

  dom.saveBtn.addEventListener("click", async () => {
    await persistSteps();
    const response = await send({ type: "SAVE_TEST_DATA" });
    if (!response?.ok) {
      setStatus("Save failed.");
      return;
    }
    savedSteps = JSON.parse(JSON.stringify(steps));
    savedRunUrl = runUrl;
    setStatus(`Test data saved (${response.savedCount}).`);
  });

  dom.exportBtn.addEventListener("click", () => {
    const payload = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      runUrl,
      savedRunUrl,
      steps,
      savedSteps,
      attachments
    };

    const fileName = `ui-recorder-test-data-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    downloadJsonFile(payload, fileName);
    setStatus("Test data exported.");
  });

  dom.importBtn.addEventListener("click", () => {
    dom.importFileInput.click();
  });

  dom.importFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const imported = normalizeImportPayload(parsed);

      const response = await send({ type: "IMPORT_TEST_DATA", payload: imported });
      if (!response?.ok) {
        setStatus(`Import failed: ${response?.error || "invalid file"}`);
        return;
      }

      steps = imported.steps;
      savedSteps = imported.savedSteps;
      runUrl = imported.runUrl;
      savedRunUrl = imported.savedRunUrl;
      attachments = imported.attachments;
      stepDebugStatus = [];
      stepDatasetStatus = new Map();
      datasetRunStatus = new Map();
      stepFailureEvidence = new Map();
      activeStepIndex = -1;
      dom.runUrlInput.value = runUrl;
      render();
      setStatus(`Imported ${response.importedCount} steps.`);
    } catch {
      setStatus("Import failed: invalid JSON file.");
    } finally {
      dom.importFileInput.value = "";
    }
  });

  dom.runBtn.addEventListener("click", async () => {
    const runtimeRunUrl = String(dom.runUrlInput.value || "").trim();

    // Ensure Run uses the latest edited datasets/steps, even if user did not click Save test data.
    await persistSteps();
    const saveSnapshot = await send({ type: "SAVE_TEST_DATA" });
    if (!saveSnapshot?.ok) {
      setStatus("Run blocked: could not save latest test data.");
      return;
    }

    const incognitoAccess = await send({ type: "GET_INCOGNITO_ACCESS" });
    if (!incognitoAccess?.ok || !incognitoAccess?.allowed) {
      setStatus("Run blocked: enable Allow in Incognito for this extension in chrome://extensions.");
      return;
    }

    const response = await send({ type: "RUN_STEPS", payload: { runUrl: runtimeRunUrl } });
    if (!response?.ok) {
      const message = `Run failed to start: ${response?.error || "unknown error"}`;
      appendRunConsole(message);
      setStatus(`Replay failed to start: ${response?.error || "unknown error"}`);
      await refreshRunHistoryFromStorage();
      return;
    }

    const report = response.report;
    if (!report) {
      setStatus("Replay completed.");
      await refreshRunHistoryFromStorage();
      return;
    }

    if (report.totalRuns === 0) {
      stepDebugStatus = [];
      stepDatasetStatus = new Map();
      datasetRunStatus = new Map();
      stepFailureEvidence = new Map();
      render();
      appendRunConsole("No saved test data found.");
      setStatus("No saved test data found. Click Save test data first.");
      await refreshRunHistoryFromStorage();
      return;
    }

    stepDebugStatus = Array.isArray(report.stepResults) ? report.stepResults : [];
    stepDatasetStatus = buildDatasetStepStatus(report);
    datasetRunStatus = buildDatasetRunStatus(report);
    stepFailureEvidence = buildStepFailureEvidence(report);
    render();

    if (Array.isArray(report.failedRuns) && report.failedRuns.length > 0) {
      appendRunConsole(formatRunFailureDetails(report));
      const firstRun = report.failedRuns[0];
      const firstFailure = firstRun.failed?.[0];
      const failedAt = firstFailure
        ? ` ${firstRun.label} stopped at step ${firstFailure.index + 1} (${formatFailureReasonForDisplay(firstFailure.reason)}).`
        : "";
      const summary = `Parallel run complete: ${report.passedRuns}/${report.totalRuns} contexts passed.${failedAt}`;
      setStatus(summary);
      await refreshRunHistoryFromStorage();
      return;
    }

    appendRunConsole(`Run success: ${report.passedRuns}/${report.totalRuns} dataset(s) passed.`);

    const summary = `Parallel run complete: ${report.passedRuns}/${report.totalRuns} contexts passed.`;
    setStatus(summary);
    await refreshRunHistoryFromStorage();
  });
}

function render() {
  renderAttachments();
  dom.stepsList.innerHTML = "";

  const visibleStepIndexes = getVisibleStepIndexes();
  visibleStepIndexes.forEach((index) => {
    const step = steps[index];
    ensureStepLocators(step);

    const fragment = dom.stepTemplate.content.cloneNode(true);
    const stepItem = fragment.querySelector(".step-item");
    const root = fragment.querySelector(".step-grid");
    const variantsRoot = fragment.querySelector(".variants");

    const elementNameInput = root.querySelector(".elementName");
    const locatorSelect = root.querySelector(".locatorSelect");
    const locatorRisk = root.querySelector(".locatorRisk");
    const deleteLocatorBtn = root.querySelector(".deleteLocator");
    const actionTypeSelect = root.querySelector(".actionType");
    const testDataInput = root.querySelector(".testData");
    const datasetTag = root.querySelector(".datasetTag");
    const addVariantBtn = root.querySelector(".addVariant");
    const waitAfterMsInput = root.querySelector(".waitAfterMs");
    const assertionEditor = root.querySelector(".assertionEditor");
    const assertionTypeSelect = root.querySelector(".assertionType");
    const assertionExpectedInput = root.querySelector(".assertionExpected");
    const assertionAttributeInput = root.querySelector(".assertionAttribute");
    const assertionTimeoutInput = root.querySelector(".assertionTimeoutMs");
    const assertionOnFailSelect = root.querySelector(".assertionOnFail");
    const toggleCommentBtn = root.querySelector(".toggleComment");
    const copyStepBtn = root.querySelector(".copyStep");
    const deleteStepBtn = root.querySelector(".deleteStep");
    const stepSettingsBtn = root.querySelector(".stepSettings");
    const stepMetadataPanel = fragment.querySelector(".stepMetadata");
    const classNameInput = fragment.querySelector(".classNameInput");
    const pageObjectNameInput = fragment.querySelector(".pageObjectNameInput");
    const stepDefInput = fragment.querySelector(".stepDefInput");
    const gherkinTypeSelect = fragment.querySelector(".gherkinTypeSelect");
    const gherkinPreview = fragment.querySelector(".gherkinPreview");
    const waitAfterMsMetaInput = fragment.querySelector(".waitAfterMsMeta");
    const waitConditionSelect = fragment.querySelector(".waitConditionSelect");

    synchronizeStepDerivedFields(steps[index]);

    stepItem.dataset.index = String(index);
    stepItem.addEventListener("dragstart", onStepDragStart);
    stepItem.addEventListener("dragover", onStepDragOver);
    stepItem.addEventListener("drop", onStepDrop);
    stepItem.addEventListener("dragleave", onStepDragLeave);
    stepItem.addEventListener("dragend", onStepDragEnd);

    const status = getStepStatus(index);
    if (index === activeStepIndex) {
      stepItem.classList.add("active");
    }
    if (status === "passed") {
      stepItem.classList.add("passed");
    } else if (status === "partial") {
      stepItem.classList.add("partial");
    } else if (status === "failed") {
      stepItem.classList.add("failed");
    }
    const isCommented = isCommentedElementName(step.elementName);
    steps[index].commentedOut = isCommented;
    if (isCommented) {
      stepItem.classList.add("commented");
    }

    elementNameInput.value = step.elementName || "";
    if (classNameInput) {
      classNameInput.value = String(step.className || "");
    }
    if (pageObjectNameInput) {
      pageObjectNameInput.value = String(step.pageObjectName || "");
    }
    if (stepDefInput) {
      stepDefInput.value = String(step.stepDef || "");
    }
    if (gherkinTypeSelect) {
      gherkinTypeSelect.value = sanitizeGherkinType(step.gherkinType, step.actionType);
    }
    if (gherkinPreview) {
      gherkinPreview.textContent = buildGherkinPreview(step);
    }
    const metadataOpen = isStepMetadataPanelOpen(step, index);
    if (stepMetadataPanel) {
      stepMetadataPanel.hidden = !metadataOpen;
    }
    if (stepSettingsBtn) {
      stepSettingsBtn.textContent = metadataOpen ? "⚙" : "⚙";
      stepSettingsBtn.title = metadataOpen ? "Close step settings" : "Open step settings";
    }
    populateLocatorSelect(locatorSelect, step);
    updateDeleteLocatorButton(deleteLocatorBtn, step);
    const fragileReason = getFragileSelectorReason(step);
    if (locatorRisk) {
      locatorRisk.hidden = !fragileReason;
      locatorRisk.title = fragileReason || "";
    }
    actionTypeSelect.value = step.actionType || "Text";
    testDataInput.value = step.testData || "";
    waitAfterMsInput.value = Number.isFinite(Number(step.waitAfterMs)) ? String(Number(step.waitAfterMs)) : "";
    const waitCondition = normalizeWaitCondition(step.waitCondition);
    step.waitCondition = waitCondition;
    if (waitAfterMsMetaInput) {
      waitAfterMsMetaInput.value = waitAfterMsInput.value;
    }
    if (waitConditionSelect) {
      waitConditionSelect.value = waitCondition;
    }
    const assertionConfig = ensureStepAssertion(step);
    const assertionMode = isAssertionStep(step);

    const actionTypeNormalized = String(step.actionType || "").toLowerCase();
    if (assertionMode) {
      testDataInput.placeholder = "Expected value (optional for exists/visible)";
      testDataInput.disabled = false;
    } else if (actionTypeNormalized === "dropdown") {
      testDataInput.placeholder = "Selected dropdown value";
      testDataInput.disabled = false;
    } else if (actionTypeNormalized === "radio") {
      testDataInput.placeholder = "Selected radio label/value";
      testDataInput.disabled = false;
    } else if (actionTypeNormalized === "checkbox") {
      testDataInput.placeholder = "Checkbox label/value";
      testDataInput.disabled = false;
    } else if (actionTypeNormalized === "uploadfile") {
      testDataInput.placeholder = "Uploaded file name";
      testDataInput.disabled = false;
    } else if (actionTypeNormalized === "wait") {
      testDataInput.placeholder = "No test data for Wait action";
      testDataInput.disabled = true;
      if (String(testDataInput.value || "").trim()) {
        steps[index].testData = "";
        testDataInput.value = "";
      }
    } else {
      testDataInput.placeholder = "Dataset 1 value";
      testDataInput.disabled = false;
    }
    if (assertionEditor) {
      assertionEditor.hidden = !assertionMode;
    }
    if (assertionTypeSelect) {
      assertionTypeSelect.value = assertionConfig.type;
    }
    if (assertionExpectedInput) {
      assertionExpectedInput.value = assertionConfig.expected;
      assertionExpectedInput.disabled = !assertionRequiresExpected(assertionConfig.type);
    }
    if (assertionAttributeInput) {
      assertionAttributeInput.value = assertionConfig.attribute || "";
      assertionAttributeInput.disabled = assertionConfig.type !== "attributeEquals";
    }
    if (assertionTimeoutInput) {
      assertionTimeoutInput.value = String(assertionConfig.timeoutMs);
    }
    if (assertionOnFailSelect) {
      assertionOnFailSelect.value = assertionConfig.onFail;
    }
    if (datasetTag) {
      datasetTag.textContent = "Dataset 1";
      const datasetOneStatus = getDatasetRunStatus(1);
      datasetTag.classList.toggle("failed", datasetOneStatus === "failed");
      datasetTag.classList.toggle("passed", datasetOneStatus === "passed");
    }
    elementNameInput.addEventListener("input", (event) => {
      const previousCommented = Boolean(steps[index].commentedOut);
      steps[index].elementName = event.target.value;
      steps[index].commentedOut = isCommentedElementName(event.target.value);
      synchronizeStepDerivedFields(steps[index]);

      // Re-render only when comment-state changes to avoid breaking text entry focus.
      if (previousCommented !== steps[index].commentedOut) {
        render();
      }

      persistSteps();
    });

    if (stepSettingsBtn) {
      stepSettingsBtn.addEventListener("click", () => {
        toggleStepMetadataPanel(step, index);
        render();
      });
    }

    if (classNameInput) {
      classNameInput.readOnly = true;
    }

    if (pageObjectNameInput) {
      pageObjectNameInput.addEventListener("input", (event) => {
        steps[index].pageObjectName = sanitizePageObjectName(event.target.value);
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
        render();
      });
    }

    if (stepDefInput) {
      stepDefInput.addEventListener("input", (event) => {
        steps[index].stepDef = sanitizeStepDef(event.target.value, steps[index].actionType, index);
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
        render();
      });
    }

    if (gherkinTypeSelect) {
      gherkinTypeSelect.addEventListener("change", (event) => {
        steps[index].gherkinType = sanitizeGherkinType(event.target.value, steps[index].actionType);
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
        render();
      });
    }

    locatorSelect.addEventListener("change", (event) => {
      const selectedKey = event.target.value;
      if (selectedKey === CREATE_NEW_LOCATOR_VALUE) {
        const created = promptForCustomLocator();
        if (created) {
          if (!Array.isArray(steps[index].locatorOptions)) {
            steps[index].locatorOptions = [];
          }

          const existing = steps[index].locatorOptions.find((item) => item.key === created.key);
          const selected = existing || created;
          if (!existing) {
            steps[index].locatorOptions.unshift(created);
          }

          steps[index].selectedLocator = selected;
          const selector = selectorFromLocator(selected);
          if (selector) {
            steps[index].selector = selector;
          }

          render();
          persistSteps();
          return;
        }

        populateLocatorSelect(locatorSelect, steps[index]);
        updateDeleteLocatorButton(deleteLocatorBtn, steps[index]);
        return;
      }

      const selected = (steps[index].locatorOptions || []).find((item) => item.key === selectedKey);
      if (selected) {
        steps[index].selectedLocator = selected;
        const selector = selectorFromLocator(selected);
        if (selector) {
          steps[index].selector = selector;
        }
      }
      updateDeleteLocatorButton(deleteLocatorBtn, steps[index]);
      persistSteps();
    });

    if (deleteLocatorBtn) {
      deleteLocatorBtn.addEventListener("click", async () => {
        const current = steps[index]?.selectedLocator;
        if (!isCustomLocator(current)) {
          return;
        }

        steps[index].locatorOptions = (steps[index].locatorOptions || []).filter((item) => item.key !== current.key);
        steps[index].selectedLocator = steps[index].locatorOptions[0] || undefined;

        const selector = selectorFromLocator(steps[index].selectedLocator);
        if (selector) {
          steps[index].selector = selector;
        }

        render();
        await persistSteps();
      });
    }

    actionTypeSelect.addEventListener("change", (event) => {
      steps[index].actionType = event.target.value;

      if (isAssertionStep(steps[index])) {
        const normalizedAssertion = ensureStepAssertion(steps[index]);
        normalizedAssertion.expected = String(steps[index].testData || normalizedAssertion.expected || "");
        steps[index].testData = normalizedAssertion.expected;
      } else if (String(steps[index].actionType || "").toLowerCase() === "wait") {
        steps[index].testData = "";
      }

      steps[index].gherkinType = defaultGherkinTypeForAction(steps[index].actionType);
      steps[index].stepDef = sanitizeStepDef(steps[index].stepDef, steps[index].actionType, index);
      synchronizeStepDerivedFields(steps[index]);

      render();
      persistSteps();
    });

    testDataInput.addEventListener("input", (event) => {
      steps[index].testData = event.target.value;

      if (isAssertionStep(steps[index])) {
        const normalizedAssertion = ensureStepAssertion(steps[index]);
        normalizedAssertion.expected = event.target.value;
      }

      synchronizeStepDerivedFields(steps[index]);

      persistSteps();
    });

    if (assertionTypeSelect) {
      assertionTypeSelect.addEventListener("change", (event) => {
        const assertion = ensureStepAssertion(steps[index]);
        assertion.type = sanitizeAssertionType(event.target.value);
        if (!assertionRequiresExpected(assertion.type)) {
          assertion.expected = "";
          steps[index].testData = "";
        }
        if (assertion.type !== "attributeEquals") {
          assertion.attribute = "";
        }
        synchronizeStepDerivedFields(steps[index]);
        render();
        persistSteps();
      });
    }

    if (assertionExpectedInput) {
      assertionExpectedInput.addEventListener("input", (event) => {
        const assertion = ensureStepAssertion(steps[index]);
        assertion.expected = event.target.value;
        steps[index].testData = event.target.value;
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
      });
    }

    if (assertionAttributeInput) {
      assertionAttributeInput.addEventListener("input", (event) => {
        const assertion = ensureStepAssertion(steps[index]);
        assertion.attribute = event.target.value;
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
      });
    }

    if (assertionTimeoutInput) {
      assertionTimeoutInput.addEventListener("input", (event) => {
        const assertion = ensureStepAssertion(steps[index]);
        const parsed = Number(String(event.target.value || "").trim());
        if (Number.isFinite(parsed) && parsed >= 250) {
          assertion.timeoutMs = parsed;
        }
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
      });
    }

    if (assertionOnFailSelect) {
      assertionOnFailSelect.addEventListener("change", (event) => {
        const assertion = ensureStepAssertion(steps[index]);
        assertion.onFail = event.target.value === "continue" ? "continue" : "stop";
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
      });
    }

    addVariantBtn.addEventListener("click", () => {
      const nextDatasetCount = getGlobalDatasetCount() + 1;
      expandAllStepsToDatasetCount(nextDatasetCount);
      render();
      persistSteps();
    });

    waitAfterMsInput.addEventListener("input", (event) => {
      const raw = String(event.target.value || "").trim();
      if (!raw) {
        delete steps[index].waitAfterMs;
      } else {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) {
          steps[index].waitAfterMs = parsed;
        }
      }
      synchronizeStepDerivedFields(steps[index]);
      if (waitAfterMsMetaInput) {
        waitAfterMsMetaInput.value = Number.isFinite(Number(steps[index].waitAfterMs)) ? String(Number(steps[index].waitAfterMs)) : "";
      }
      persistSteps();
    });

    if (waitAfterMsMetaInput) {
      waitAfterMsMetaInput.addEventListener("input", (event) => {
        const raw = String(event.target.value || "").trim();
        if (!raw) {
          delete steps[index].waitAfterMs;
          waitAfterMsInput.value = "";
        } else {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed >= 0) {
            steps[index].waitAfterMs = parsed;
            waitAfterMsInput.value = String(parsed);
          }
        }
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
      });
    }

    if (waitConditionSelect) {
      waitConditionSelect.addEventListener("change", (event) => {
        steps[index].waitCondition = normalizeWaitCondition(event.target.value);
        synchronizeStepDerivedFields(steps[index]);
        persistSteps();
        render();
      });
    }

    if (copyStepBtn) {
      copyStepBtn.addEventListener("click", async () => {
        const source = steps[index];
        const clone = JSON.parse(JSON.stringify(source));
        clone.id = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        clone.createdAt = new Date().toISOString();

        copiedStepText = serializeStepForClipboard(clone);
        try {
          await navigator.clipboard.writeText(copiedStepText);
        } catch {
        }

        steps.splice(index + 1, 0, clone);
        render();
        await persistSteps();
        setStatus("Step cloned and copied. Use Add step + paste or Paste step.");
      });
    }

    deleteStepBtn.addEventListener("click", async () => {
      steps.splice(index, 1);
      render();
      await persistSteps();
    });

    const variants = Array.isArray(step.variants) ? step.variants : [];
    variants.forEach((variant, variantIndex) => {
      const row = document.createElement("div");
      row.className = "variant-row";
      const datasetNumber = variantIndex + 2;
      const datasetStatus = getDatasetStepStatus(index, datasetNumber);
      const datasetRun = getDatasetRunStatus(datasetNumber);
      if (datasetStatus === "failed" || datasetRun === "failed") {
        row.classList.add("failed");
      } else if (datasetStatus === "passed" || datasetRun === "passed") {
        row.classList.add("passed");
      }

      const tag = document.createElement("span");
      tag.className = "datasetTag";
      tag.textContent = `Dataset ${variantIndex + 2}`;
      tag.classList.toggle("failed", datasetRun === "failed");
      tag.classList.toggle("passed", datasetRun === "passed");

      const input = document.createElement("input");
      input.type = "text";
      input.value = variant;
      input.placeholder = `Dataset ${variantIndex + 2} value`;
      input.addEventListener("input", (event) => {
        steps[index].variants[variantIndex] = event.target.value;
        persistSteps();
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "removeVariant";
      removeBtn.textContent = "-";
      removeBtn.addEventListener("click", () => {
        removeDatasetAcrossAllSteps(variantIndex);
        render();
        persistSteps();
      });

      row.append(tag, input, removeBtn);
      variantsRoot.append(row);
    });

    const failureEvidence = stepFailureEvidence.get(index);
    if (failureEvidence?.dataUrl) {
      const evidenceRow = document.createElement("div");
      evidenceRow.className = "failureEvidence";

      const evidenceText = document.createElement("span");
      evidenceText.textContent = `Failure evidence: ${failureEvidence.runLabel || "Dataset"} (${failureEvidence.reason || "failed"})`;

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "ghost";
      viewBtn.textContent = "View screenshot";
      viewBtn.addEventListener("click", () => {
        openFailureScreenshotPreview(failureEvidence, index);
      });

      evidenceRow.append(evidenceText, viewBtn);
      variantsRoot.append(evidenceRow);
    }

    dom.stepsList.append(fragment);
  });

  if (steps.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No steps yet. Open any page, enable recording, then type/click.";
    empty.style.fontSize = "12px";
    empty.style.color = "#4b5563";
    dom.stepsList.append(empty);
  } else if (visibleStepIndexes.length === 0) {
    const emptyFiltered = document.createElement("div");
    emptyFiltered.textContent = "No steps match current filters.";
    emptyFiltered.style.fontSize = "12px";
    emptyFiltered.style.color = "#4b5563";
    dom.stepsList.append(emptyFiltered);
  }
}

function getVisibleStepIndexes() {
  const indexes = [];

  steps.forEach((step, index) => {
    if (matchesStepFilters(step)) {
      indexes.push(index);
    }
  });

  return indexes;
}

function matchesStepFilters(step) {
  const labelFilter = normalizeFilterText(stepFilters.label);
  const classFilter = normalizeFilterText(stepFilters.className);
  const pageObjectFilter = normalizeFilterText(stepFilters.pageObjectName);

  const labelText = normalizeFilterText(step?.elementName || "");
  const classText = normalizeFilterText(step?.className || "");
  const pageObjectText = normalizeFilterText(step?.pageObjectName || "");

  if (labelFilter && !labelText.includes(labelFilter)) {
    return false;
  }
  if (classFilter && !classText.includes(classFilter)) {
    return false;
  }
  if (pageObjectFilter && !pageObjectText.includes(pageObjectFilter)) {
    return false;
  }

  return true;
}

function normalizeFilterText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getStepMetadataPanelKey(step, index) {
  if (step && typeof step.id === "string" && step.id.trim()) {
    return step.id;
  }
  return `step-${index}`;
}

function isStepMetadataPanelOpen(step, index) {
  const key = getStepMetadataPanelKey(step, index);
  return stepMetadataPanelKeys.has(key);
}

function toggleStepMetadataPanel(step, index) {
  const key = getStepMetadataPanelKey(step, index);
  if (stepMetadataPanelKeys.has(key)) {
    stepMetadataPanelKeys.delete(key);
  } else {
    stepMetadataPanelKeys.add(key);
  }
}

function ensureStepLocators(step) {
  if (Array.isArray(step.locatorOptions)) {
    step.locatorOptions = step.locatorOptions.filter((locator) => SUPPORTED_LOCATOR_STRATEGIES.has(locator?.strategy));
  }

  if (!Array.isArray(step.locatorOptions) || step.locatorOptions.length === 0) {
    const fallbackSelector = typeof step.selector === "string" ? step.selector : "";
    if (fallbackSelector) {
      step.locatorOptions = [
        {
          key: `selector|${fallbackSelector}`,
          strategy: "selector",
          value: fallbackSelector,
          label: `selector: ${fallbackSelector}`
        }
      ];
    } else {
      step.locatorOptions = [];
    }
  }

  if (step.selectedLocator && !SUPPORTED_LOCATOR_STRATEGIES.has(step.selectedLocator.strategy)) {
    step.selectedLocator = undefined;
  }

  const preferredOrder = ["xpath", "name", "id", "data-testid", "aria-label", "text", "selector"];
  const rank = new Map(preferredOrder.map((strategy, index) => [strategy, index]));
  const bestLocator = (step.locatorOptions || []).reduce((best, locator) => {
    if (!locator?.strategy) {
      return best;
    }
    if (!best) {
      return locator;
    }

    const currentRank = rank.has(locator.strategy) ? rank.get(locator.strategy) : Number.MAX_SAFE_INTEGER;
    const bestRank = rank.has(best.strategy) ? rank.get(best.strategy) : Number.MAX_SAFE_INTEGER;
    return currentRank < bestRank ? locator : best;
  }, null);

  if (bestLocator) {
    const selectedRank = rank.has(step.selectedLocator?.strategy)
      ? rank.get(step.selectedLocator.strategy)
      : Number.MAX_SAFE_INTEGER;
    const bestRank = rank.has(bestLocator.strategy) ? rank.get(bestLocator.strategy) : Number.MAX_SAFE_INTEGER;

    if (!step.selectedLocator || bestRank < selectedRank) {
      step.selectedLocator = bestLocator;
      step.selector = selectorFromLocator(bestLocator) || step.selector;
    }
  }

  if (!step.selectedLocator && step.locatorOptions.length > 0) {
    step.selectedLocator = step.locatorOptions[0];
  }

  if (isAssertionStep(step)) {
    ensureStepAssertion(step);
  }
}

function getGlobalDatasetCount() {
  const maxVariants = steps.reduce((count, step) => {
    const variantCount = Array.isArray(step?.variants) ? step.variants.length : 0;
    return Math.max(count, variantCount);
  }, 0);

  return maxVariants + 1;
}

function expandAllStepsToDatasetCount(datasetCount) {
  const targetVariantsCount = Math.max(0, datasetCount - 1);

  steps.forEach((step) => {
    if (!Array.isArray(step.variants)) {
      step.variants = [];
    }

    while (step.variants.length < targetVariantsCount) {
      step.variants.push(step.testData || "");
    }
  });
}

function removeDatasetAcrossAllSteps(variantIndex) {
  steps.forEach((step) => {
    if (!Array.isArray(step?.variants)) {
      return;
    }

    if (variantIndex >= 0 && variantIndex < step.variants.length) {
      step.variants.splice(variantIndex, 1);
    }
  });
}

function populateLocatorSelect(locatorSelect, step) {
  locatorSelect.innerHTML = "";
  locatorSelect.classList.add("has-create-option");
  const selectedKey = step.selectedLocator?.key;

  (step.locatorOptions || []).forEach((locator) => {
    const option = document.createElement("option");
    option.value = locator.key;
    option.textContent = locator.label || `${locator.strategy}: ${locator.value}`;
    if (selectedKey && selectedKey === locator.key) {
      option.selected = true;
    }
    locatorSelect.append(option);
  });

  const createOption = document.createElement("option");
  createOption.value = CREATE_NEW_LOCATOR_VALUE;
  createOption.textContent = "+ Create New Locator";
  createOption.style.color = "#2563eb";
  locatorSelect.append(createOption);
}

function promptForCustomLocator() {
  const strategyInput = window.prompt(
    `Enter locator strategy (${CUSTOM_LOCATOR_STRATEGIES.join(", ")})`,
    "xpath"
  );
  if (strategyInput === null) {
    return null;
  }

  const strategy = String(strategyInput || "").trim().toLowerCase();
  if (!CUSTOM_LOCATOR_STRATEGIES.includes(strategy)) {
    window.alert(`Unsupported strategy: ${strategy}.`);
    return null;
  }

  const valueHint = strategy === "xpath" ? "//button[@aria-label='Open combobox list']" : "";
  const valueInput = window.prompt(`Enter locator value for '${strategy}'`, valueHint);
  if (valueInput === null) {
    return null;
  }

  const value = String(valueInput || "").trim();
  if (!value) {
    window.alert("Locator value cannot be empty.");
    return null;
  }

  const key = createLocatorKey(strategy, value);
  return {
    key,
    strategy,
    value,
    label: `${strategy}: ${value}`
  };
}

function createLocatorKey(strategy, value) {
  return `custom|${strategy}|${value}`;
}

function isCustomLocator(locator) {
  return Boolean(locator?.key && String(locator.key).startsWith("custom|"));
}

function updateDeleteLocatorButton(button, step) {
  if (!button) {
    return;
  }

  const selected = step?.selectedLocator;
  const canDelete = isCustomLocator(selected);
  button.hidden = !canDelete;
  button.disabled = !canDelete;
}

function getFragileSelectorReason(step) {
  const selector = String(step?.selector || "").trim();
  const selectedStrategy = String(step?.selectedLocator?.strategy || "").toLowerCase();

  if (selector.startsWith("body >")) {
    return "Selector starts from body and is usually unstable across page updates.";
  }

  if ((selector.match(/nth-of-type\(/gi) || []).length >= 2) {
    return "Selector relies on multiple nth-of-type segments and may break when DOM order changes.";
  }

  if (selectedStrategy === "xpath") {
    const xpath = String(step?.selectedLocator?.value || "").trim();
    if (xpath.startsWith("/html") || xpath.startsWith("//html")) {
      return "Absolute XPath is fragile. Prefer id, name, aria-label, or compact relative XPath.";
    }
  }

  return "";
}

function selectorFromLocator(locator) {
  if (!locator || !locator.strategy || !locator.value) {
    return "";
  }

  if (locator.strategy === "data-testid") {
    return `[data-testid="${cssEscapeForAttr(locator.value)}"]`;
  }

  if (locator.strategy === "aria-label") {
    return `[aria-label="${cssEscapeForAttr(locator.value)}"]`;
  }

  if (locator.strategy === "id") {
    return `#${cssEscapeForAttr(locator.value)}`;
  }

  if (locator.strategy === "name") {
    return `[name="${cssEscapeForAttr(locator.value)}"]`;
  }

  if (locator.strategy === "selector") {
    return locator.value;
  }

  if (locator.strategy === "xpath") {
    return locator.value;
  }

  return "";
}

function cssEscapeForAttr(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function onStepDragStart(event) {
  const stepItem = event.currentTarget;
  dragFromIndex = Number(stepItem.dataset.index);
  stepItem.classList.add("dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(dragFromIndex));
  }
}

function onStepDragOver(event) {
  event.preventDefault();
  const stepItem = event.currentTarget;
  const overIndex = Number(stepItem.dataset.index);
  if (dragFromIndex === null || dragFromIndex === overIndex) {
    return;
  }
  stepItem.classList.add("drop-target");
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

async function onStepDrop(event) {
  event.preventDefault();
  const stepItem = event.currentTarget;
  const dropIndex = Number(stepItem.dataset.index);
  stepItem.classList.remove("drop-target");

  if (dragFromIndex === null || dragFromIndex === dropIndex) {
    return;
  }

  const [moved] = steps.splice(dragFromIndex, 1);
  steps.splice(dropIndex, 0, moved);

  dragFromIndex = null;
  render();
  await persistSteps();
}

function onStepDragLeave(event) {
  event.currentTarget.classList.remove("drop-target");
}

function onStepDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  event.currentTarget.classList.remove("drop-target");
  dragFromIndex = null;
}

async function persistSteps() {
  await send({ type: "UPDATE_STEPS", payload: { steps, runUrl } });
}

function sanitizePopupStepList(stepList) {
  return (Array.isArray(stepList) ? stepList : []).map((step, index) => normalizePopupStep(step, index));
}

function normalizeImportPayload(parsed) {
  const importedSteps = sanitizePopupStepList(Array.isArray(parsed?.steps) ? parsed.steps : []);
  const importedSavedSteps = sanitizePopupStepList(Array.isArray(parsed?.savedSteps) ? parsed.savedSteps : importedSteps);
  const importedAttachments = Array.isArray(parsed?.attachments) ? parsed.attachments : [];

  return {
    steps: importedSteps,
    savedSteps: importedSavedSteps,
    runUrl: typeof parsed?.runUrl === "string" ? parsed.runUrl : "",
    savedRunUrl: typeof parsed?.savedRunUrl === "string" ? parsed.savedRunUrl : "",
    attachments: importedAttachments
  };
}

function createEmptyStep() {
  const id = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return normalizePopupStep({
    id,
    elementName: "",
    className: "",
    pageObjectName: inferPageObjectName(runUrl || "") || "HomePage",
    stepDef: "clickStep",
    gherkinType: "When",
    gherkinText: "user clicks \"this element\"",
    actionType: "Click",
    selector: "",
    locatorOptions: [],
    selectedLocator: undefined,
    testData: "",
    variants: [],
    pageUrl: runUrl || "",
    waitCondition: "afterDelay",
    createdAt: new Date().toISOString(),
    commentedOut: false,
    assertion: undefined
  });
}

function serializeStepForClipboard(step) {
  return JSON.stringify(
    {
      type: "ui-automation-step",
      version: 1,
      step
    },
    null,
    2
  );
}

function parseStepFromClipboardText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const candidate =
    parsed?.type === "ui-automation-step" && parsed?.step
      ? parsed.step
      : Array.isArray(parsed)
        ? parsed[0]
        : parsed;

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const looksLikeStep =
    Object.prototype.hasOwnProperty.call(candidate, "actionType") ||
    Object.prototype.hasOwnProperty.call(candidate, "elementName") ||
    Object.prototype.hasOwnProperty.call(candidate, "selector") ||
    Object.prototype.hasOwnProperty.call(candidate, "locatorOptions");

  if (!looksLikeStep) {
    return null;
  }

  const normalized = {
    ...createEmptyStep(),
    ...JSON.parse(JSON.stringify(candidate)),
    id: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString()
  };

  normalized.elementName = String(normalized.elementName || "");
  normalized.className = String(normalized.className || "");
  normalized.pageObjectName = sanitizePageObjectName(normalized.pageObjectName || inferPageObjectName(normalized.pageUrl || runUrl || "") || "");
  normalized.stepDef = sanitizeStepDef(normalized.stepDef || "", normalized.actionType || "Click");
  normalized.gherkinType = sanitizeGherkinType(normalized.gherkinType, normalized.actionType);
  normalized.actionType = String(normalized.actionType || "Click");
  normalized.selector = String(normalized.selector || "");
  normalized.testData = String(normalized.testData || "");
  normalized.pageUrl = String(normalized.pageUrl || runUrl || "");
  normalized.waitCondition = normalizeWaitCondition(normalized.waitCondition);
  normalized.commentedOut = isCommentedElementName(normalized.elementName);
  normalized.variants = Array.isArray(normalized.variants) ? normalized.variants.map((item) => String(item ?? "")) : [];
  if (!Array.isArray(normalized.locatorOptions)) {
    normalized.locatorOptions = [];
  }

  ensureStepLocators(normalized);
  if (isAssertionStep(normalized)) {
    ensureStepAssertion(normalized);
  } else {
    normalized.assertion = undefined;
  }

  synchronizeStepDerivedFields(normalized);

  return normalized;
}

function normalizePopupStep(step, index) {
  const normalized = {
    ...createStepSkeleton(),
    ...JSON.parse(JSON.stringify(step || {}))
  };

  normalized.id = String(normalized.id || (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`));
  normalized.elementName = String(normalized.elementName || "");
  normalized.actionType = String(normalized.actionType || "Click");
  normalized.selector = String(normalized.selector || "");
  normalized.testData = String(normalized.testData || "");
  normalized.className = String(normalized.className || "");
  normalized.pageUrl = String(normalized.pageUrl || runUrl || "");
  normalized.pageObjectName = sanitizePageObjectName(normalized.pageObjectName || inferPageObjectName(normalized.pageUrl || "") || "");
  normalized.stepDef = sanitizeStepDef(normalized.stepDef || "", normalized.actionType, index);
  normalized.gherkinType = sanitizeGherkinType(normalized.gherkinType, normalized.actionType);
  normalized.waitCondition = normalizeWaitCondition(normalized.waitCondition);
  normalized.commentedOut = isCommentedElementName(normalized.elementName);
  normalized.variants = Array.isArray(normalized.variants) ? normalized.variants.map((item) => String(item ?? "")) : [];
  normalized.locatorOptions = Array.isArray(normalized.locatorOptions) ? normalized.locatorOptions : [];
  if (isAssertionStep(normalized)) {
    ensureStepAssertion(normalized);
  } else {
    normalized.assertion = undefined;
  }
  synchronizeStepDerivedFields(normalized);
  return normalized;
}

function createStepSkeleton() {
  return {
    id: "",
    elementName: "",
    className: "",
    pageObjectName: "",
    stepDef: "",
    gherkinType: "When",
    gherkinText: "",
    actionType: "Click",
    selector: "",
    locatorOptions: [],
    selectedLocator: undefined,
    testData: "",
    variants: [],
    pageUrl: runUrl || "",
    waitCondition: "afterDelay",
    createdAt: new Date().toISOString(),
    commentedOut: false,
    assertion: undefined
  };
}

function splitIntoWords(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function toPascalIdentifier(value, fallback = "") {
  const words = splitIntoWords(value).filter((word) => !/^(a|an|the)$/.test(word.toLowerCase()));
  if (words.length === 0) {
    return fallback;
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function toCamelIdentifier(value, fallback = "") {
  const pascal = toPascalIdentifier(value, "");
  if (!pascal) {
    return fallback;
  }
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function inferPageObjectName(pageUrl) {
  const rawUrl = String(pageUrl || "").trim();
  if (!rawUrl) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "home";
    return `${toPascalIdentifier(lastSegment, "Home")}Page`;
  } catch {
    return "";
  }
}

function sanitizePageObjectName(value) {
  return toPascalIdentifier(value, "");
}

function verbForActionType(actionType) {
  switch (String(actionType || "").trim().toLowerCase()) {
    case "text":
      return "enter";
    case "dropdown":
      return "select";
    case "radio":
      return "select";
    case "checkbox":
      return "check";
    case "uploadfile":
      return "upload";
    case "wait":
      return "waitFor";
    case "assert":
      return "assert";
    case "clicklogout":
      return "click";
    case "click":
    default:
      return "click";
  }
}

function sanitizeStepDef(value, actionType, index = 0) {
  const explicit = toCamelIdentifier(value, "");
  if (explicit) {
    return explicit;
  }

  const fallbackName = steps[index]?.elementName || "Step";
  const noun = toPascalIdentifier(fallbackName, "Step");
  return `${verbForActionType(actionType)}${noun}`;
}

function defaultGherkinTypeForAction(actionType) {
  return String(actionType || "").trim().toLowerCase() === "assert" ? "Then" : "When";
}

function sanitizeGherkinType(value, actionType) {
  const normalized = String(value || "").trim();
  if (GHERKIN_TYPES.has(normalized)) {
    return normalized;
  }
  return defaultGherkinTypeForAction(actionType);
}

function buildAssertionPreview(assertion, elementName) {
  const normalizedElement = String(elementName || "this element").trim() || "this element";
  const type = String(assertion?.type || "visible");
  const expected = String(assertion?.expected || "").trim();

  switch (type) {
    case "exists":
      return `"${normalizedElement}" exists`;
    case "visible":
      return `"${normalizedElement}" is visible`;
    case "textEquals":
      return `"${normalizedElement}" text equals "${expected}"`;
    case "textContains":
      return `"${normalizedElement}" text contains "${expected}"`;
    case "valueEquals":
      return `"${normalizedElement}" value equals "${expected}"`;
    case "attributeEquals":
      return `"${normalizedElement}" attribute "${String(assertion?.attribute || "attribute")}" equals "${expected}"`;
    case "urlContains":
      return `current URL contains "${expected}"`;
    case "titleContains":
      return `page title contains "${expected}"`;
    default:
      return `"${normalizedElement}" is valid`;
  }
}

function buildGherkinText(step) {
  const elementName = String(step?.elementName || "this element").trim() || "this element";
  const testData = String(step?.testData || "").trim();
  switch (String(step?.actionType || "").trim().toLowerCase()) {
    case "text":
      return `user enters "${testData}" into "${elementName}" field`;
    case "dropdown":
      return `user selects "${testData}" from "${elementName}" dropdown`;
    case "radio":
      return `user selects "${testData || elementName}" radio option`;
    case "checkbox":
      return `user checks "${elementName}" checkbox`;
    case "uploadfile":
      return `user uploads "${testData || step?.uploadedFileName || "file"}" into "${elementName}"`;
    case "wait":
      return step?.waitCondition === "untilElementVisible"
        ? `user waits until "${elementName}" is visible`
        : `user waits ${Number.isFinite(Number(step?.waitAfterMs)) ? `${Number(step.waitAfterMs)} ms` : "for the next step"}`;
    case "assert":
      return buildAssertionPreview(step?.assertion, elementName);
    case "clicklogout":
      return `user clicks logout on "${elementName}"`;
    case "click":
    default:
      return `user clicks "${elementName}"`;
  }
}

function synchronizeStepDerivedFields(step) {
  if (!step || typeof step !== "object") {
    return step;
  }

  step.pageObjectName = sanitizePageObjectName(step.pageObjectName || inferPageObjectName(step.pageUrl || runUrl || "") || "");
  step.stepDef = sanitizeStepDef(step.stepDef || step.elementName || "", step.actionType);
  step.gherkinType = sanitizeGherkinType(step.gherkinType, step.actionType);
  step.className = step.pageObjectName && step.stepDef ? `${step.pageObjectName}.${step.stepDef}` : "";
  step.gherkinText = buildGherkinText(step);
  return step;
}

function buildGherkinPreview(step) {
  const type = sanitizeGherkinType(step?.gherkinType, step?.actionType);
  const text = String(step?.gherkinText || buildGherkinText(step) || "").trim();
  return text ? `${type} ${text}` : type;
}

async function readStepFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const parsed = parseStepFromClipboardText(text);
    if (parsed) {
      copiedStepText = text;
      return parsed;
    }
  } catch {
  }

  return parseStepFromClipboardText(copiedStepText);
}

function isAssertionStep(step) {
  return String(step?.actionType || "").toLowerCase() === "assert";
}

function sanitizeAssertionType(type) {
  const value = String(type || "").trim();
  if (ASSERTION_TYPES.has(value)) {
    return value;
  }
  return "textContains";
}

function assertionRequiresExpected(type) {
  return !["exists", "visible"].includes(String(type || ""));
}

function normalizeWaitCondition(value) {
  const condition = String(value || "afterDelay").trim();
  if (WAIT_CONDITIONS.has(condition)) {
    return condition;
  }
  return "afterDelay";
}

function ensureStepAssertion(step) {
  const current = step?.assertion || {};
  const normalized = {
    type: sanitizeAssertionType(current.type),
    expected: String(current.expected ?? step?.testData ?? ""),
    attribute: String(current.attribute || ""),
    timeoutMs: Number.isFinite(Number(current.timeoutMs)) && Number(current.timeoutMs) >= 250 ? Number(current.timeoutMs) : 8000,
    pollIntervalMs:
      Number.isFinite(Number(current.pollIntervalMs)) && Number(current.pollIntervalMs) >= 50
        ? Number(current.pollIntervalMs)
        : 250,
    onFail: current.onFail === "continue" ? "continue" : "stop",
    negate: Boolean(current.negate)
  };

  if (!assertionRequiresExpected(normalized.type)) {
    normalized.expected = "";
  }
  if (normalized.type !== "attributeEquals") {
    normalized.attribute = "";
  }

  step.assertion = normalized;
  return normalized;
}

function isCommentedElementName(value) {
  const text = String(value || "").trim();
  return /^\/\/(?![.#\[])/.test(text);
}

function downloadJsonFile(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

function getStepStatus(index) {
  const entry = stepDebugStatus.find((result) => result.index === index);
  return entry?.status || "";
}

function getDatasetStepStatus(stepIndex, datasetNumber) {
  return stepDatasetStatus.get(`${stepIndex}|${datasetNumber}`) || "";
}

function getDatasetRunStatus(datasetNumber) {
  return datasetRunStatus.get(datasetNumber) || "";
}

function buildDatasetStepStatus(report) {
  const map = new Map();
  const runs = Array.isArray(report?.runs) ? report.runs : [];

  runs.forEach((run) => {
    const runIndex = Number.isInteger(run?.runIndex) ? run.runIndex : -1;
    const datasetNumber = runIndex >= 0 ? runIndex + 1 : 0;
    if (datasetNumber <= 0) {
      return;
    }

    const results = Array.isArray(run?.stepResults) ? run.stepResults : [];
    results.forEach((entry) => {
      const stepIndex = Number(entry?.index);
      const status = String(entry?.status || "").trim().toLowerCase();
      if (!Number.isInteger(stepIndex) || !status) {
        return;
      }

      map.set(`${stepIndex}|${datasetNumber}`, status);
    });
  });

  return map;
}

function buildDatasetRunStatus(report) {
  const map = new Map();
  const runs = Array.isArray(report?.runs) ? report.runs : [];

  runs.forEach((run) => {
    const runIndex = Number.isInteger(run?.runIndex) ? run.runIndex : -1;
    const datasetNumber = runIndex >= 0 ? runIndex + 1 : 0;
    if (datasetNumber <= 0) {
      return;
    }

    const failures = Array.isArray(run?.failed) ? run.failed : [];
    map.set(datasetNumber, failures.length > 0 ? "failed" : "passed");
  });

  return map;
}

function formatFailureReasonForDisplay(reason) {
  const rawReason = String(reason || "unknown").trim();
  if (!rawReason) {
    return "unknown";
  }

  if (rawReason.startsWith("assertion-")) {
    return `failed due to assertion (${rawReason})`;
  }

  return rawReason;
}

function buildStepFailureEvidence(report) {
  const map = new Map();
  const failedRuns = Array.isArray(report?.failedRuns) ? report.failedRuns : [];

  failedRuns.forEach((run) => {
    const runLabel = String(run?.label || "Dataset");
    const failures = Array.isArray(run?.failed) ? run.failed : [];
    failures.forEach((item) => {
      const stepIndex = Number(item?.index);
      const screenshot = item?.screenshot;
      const dataUrl = String(screenshot?.dataUrl || "");
      if (!Number.isInteger(stepIndex) || !dataUrl || map.has(stepIndex)) {
        return;
      }

      map.set(stepIndex, {
        runLabel,
        reason: String(item?.reason || "failed"),
        dataUrl,
        capturedAt: String(screenshot?.capturedAt || "")
      });
    });
  });

  return map;
}

function setStatus(text) {
  dom.status.textContent = text;
  setTimeout(() => {
    if (dom.status.textContent === text) {
      dom.status.textContent = "";
    }
  }, 2000);
}

function clearRunConsole() {
  if (!dom.runConsole) {
    return;
  }

  dom.runConsole.textContent = "";
}

function renderRunHistoryConsole() {
  if (!dom.runConsole) {
    return;
  }

  if (!Array.isArray(runHistoryEntries) || runHistoryEntries.length === 0) {
    dom.runConsole.textContent = "No run logs yet.";
    return;
  }

  const preview = runHistoryEntries.slice(0, 8).map((entry) => {
    const time = String(entry?.createdAt || "");
    const title = String(entry?.title || "Run").trim();
    return time ? `[${time}] ${title}` : title;
  });

  dom.runConsole.textContent = preview.join("\n");
}

async function refreshRunHistoryFromStorage() {
  const response = await send({ type: "GET_STEPS" });
  if (!response?.ok) {
    return;
  }

  runHistoryEntries = Array.isArray(response.runHistory) ? response.runHistory : [];
  applyRunSnapshot(response?.runSnapshot);
  renderRunHistoryConsole();
  render();
}

function applyRunSnapshot(snapshot) {
  const entries = Array.isArray(snapshot?.stepStatuses) ? snapshot.stepStatuses : [];
  stepDebugStatus = entries
    .map((entry) => ({
      index: Number(entry?.index),
      status: String(entry?.status || ""),
      reason: String(entry?.reason || "")
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.status);

  const evidenceEntries = Array.isArray(snapshot?.failureEvidence) ? snapshot.failureEvidence : [];
  stepFailureEvidence = new Map();
  datasetRunStatus = new Map();
  evidenceEntries.forEach((entry) => {
    const stepIndex = Number(entry?.index);
    const dataUrl = String(entry?.dataUrl || "");
    if (!Number.isInteger(stepIndex) || !dataUrl.startsWith("data:image/")) {
      return;
    }

    stepFailureEvidence.set(stepIndex, {
      runLabel: String(entry?.runLabel || "Dataset"),
      reason: String(entry?.reason || "failed"),
      dataUrl,
      capturedAt: String(entry?.capturedAt || "")
    });
  });

  if (Boolean(snapshot?.inProgress)) {
    activeStepIndex = Number.isInteger(snapshot?.activeStepIndex) ? snapshot.activeStepIndex : -1;
  } else {
    activeStepIndex = -1;
  }
}

function openFailureScreenshotPreview(failureEvidence, stepIndex) {
  const dataUrl = String(failureEvidence?.dataUrl || "");
  if (!dataUrl.startsWith("data:image/")) {
    return;
  }

  const stepNumber = Number.isInteger(stepIndex) ? stepIndex + 1 : "?";
  const runLabel = String(failureEvidence?.runLabel || "Dataset");
  const reason = String(failureEvidence?.reason || "failed");
  const capturedAt = String(failureEvidence?.capturedAt || "");
  const escapedRunLabel = escapeHtml(runLabel);
  const escapedReason = escapeHtml(reason);
  const escapedCapturedAt = escapeHtml(capturedAt);
  const previewHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Failure Screenshot - Step ${stepNumber}</title>
    <style>
      body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
      .meta { padding: 10px 14px; background: #111827; border-bottom: 1px solid #1f2937; font-size: 12px; }
      img { display: block; width: 100%; height: auto; background: #000; }
    </style>
  </head>
  <body>
    <div class="meta">Step ${stepNumber} | ${escapedRunLabel} | reason=${escapedReason}${escapedCapturedAt ? ` | ${escapedCapturedAt}` : ""}</div>
    <img src="${dataUrl}" alt="Failure screenshot Step ${stepNumber}" />
  </body>
</html>`;

  const previewBlob = new Blob([previewHtml], { type: "text/html" });
  const previewUrl = URL.createObjectURL(previewBlob);
  const opened = window.open(previewUrl, "_blank");
  if (!opened) {
    URL.revokeObjectURL(previewUrl);
    return;
  }

  setTimeout(() => URL.revokeObjectURL(previewUrl), 60000);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendRunConsole(text) {
  if (!dom.runConsole) {
    return;
  }

  const line = String(text || "").trim();
  if (!line) {
    return;
  }

  dom.runConsole.textContent = dom.runConsole.textContent
    ? `${dom.runConsole.textContent}\n${line}`
    : line;
  dom.runConsole.scrollTop = dom.runConsole.scrollHeight;
}

function formatRunFailureDetails(report) {
  const failedRuns = Array.isArray(report?.failedRuns) ? report.failedRuns : [];
  if (failedRuns.length === 0) {
    return "No failures.";
  }

  const lines = [`Failures: ${failedRuns.length} dataset(s).`];

  failedRuns.forEach((run) => {
    const runLabel = String(run?.label || "Dataset");
    const failures = Array.isArray(run?.failed) ? run.failed : [];
    if (failures.length === 0) {
      lines.push(`${runLabel}: failed (no detailed step records).`);
      return;
    }

    failures.forEach((item) => {
      const stepNumber = Number.isInteger(item?.index) ? item.index + 1 : "?";
      const reason = formatFailureReasonForDisplay(item?.reason);
      const elementName = String(item?.elementName || "Unknown");
      const selector = String(item?.selector || "");
      const pageUrl = String(item?.pageUrl || "");
      lines.push(`${runLabel} | Step ${stepNumber} | reason=${reason}`);
      lines.push(`  element=${elementName}`);
      if (selector) {
        lines.push(`  selector=${selector}`);
      }
      if (pageUrl) {
        lines.push(`  url=${pageUrl}`);
      }
      if (String(item?.screenshot?.dataUrl || "").startsWith("data:image/")) {
        lines.push("  screenshot=captured");
      }
    });
  });

  return lines.join("\n");
}

function renderAttachments() {
  if (!dom.attachmentsList) {
    return;
  }

  dom.attachmentsList.innerHTML = "";
  if (!Array.isArray(attachments) || attachments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "attachment-empty";
    empty.textContent = "No uploaded attachments.";
    dom.attachmentsList.append(empty);
    return;
  }

  attachments.forEach((attachment) => {
    const row = document.createElement("div");
    row.className = "attachment-item";

    const meta = document.createElement("div");
    meta.className = "attachment-meta";

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = String(attachment.fileName || "document.pdf");

    const pill = document.createElement("span");
    pill.className = "attachment-pill";
    pill.textContent = attachment.hasContent ? "stored" : "metadata";

    meta.append(name, pill);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      if (!attachment.id) {
        return;
      }

      const response = await send({
        type: "DELETE_ATTACHMENT",
        payload: { attachmentId: attachment.id }
      });

      if (!response?.ok) {
        setStatus(`Could not remove attachment: ${response?.error || "unknown"}`);
        return;
      }

      attachments = Array.isArray(response.attachments) ? response.attachments : [];
      renderAttachments();
      setStatus("Attachment removed.");
    });

    row.append(meta, removeBtn);
    dom.attachmentsList.append(row);
  });
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    const text = String(error || "");
    if (/A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i.test(text)) {
      return { ok: false, error: "message-channel-closed" };
    }
    throw error;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
