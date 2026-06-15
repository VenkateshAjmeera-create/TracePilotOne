const RECORDER_INSTANCE_ATTR = "data-ui-automation-recorder-instance";
const RECORDER_STATE_KEY = "__tracePilotRecorderState";
const MAX_CAPTURE_TEXT_LENGTH = 400;
const LOCATOR_PRIORITY = ["data-testid-index", "aria-label-index", "xpath", "data-testid", "aria-label", "text", "name", "id"];
const CLICK_DEDUPE_WINDOW_MS = 600;
const VALUE_CAPTURE_DEDUPE_WINDOW_MS = 500;
let lastClickCapture = { key: "", at: 0 };
let lastValueCapture = { key: "", at: 0 };

function getRecorderState() {
  const state = globalThis[RECORDER_STATE_KEY];
  if (state && typeof state === "object") {
    return state;
  }

  const next = {
    attached: false,
    listenersBound: false
  };
  globalThis[RECORDER_STATE_KEY] = next;
  return next;
}

function claimRecorderInstance() {
  const root = document.documentElement;
  if (!root) {
    return false;
  }

  const existing = String(root.getAttribute(RECORDER_INSTANCE_ATTR) || "").trim();
  if (!existing || existing !== chrome.runtime.id) {
    root.setAttribute(RECORDER_INSTANCE_ATTR, chrome.runtime.id);
  }

  return true;
}

const isPrimaryRecorderInstance = claimRecorderInstance();
const recorderState = getRecorderState();

function toFriendlyName(element) {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("data-testid") ||
    element.getAttribute("data-test") ||
    element.getAttribute("name") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("id") ||
    element.innerText ||
    element.tagName;

  return String(label).trim().replace(/\s+/g, " ").slice(0, 60) || "Unknown";
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function truncateForLabel(value, max = 60) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function truncateCaptureText(value) {
  const text = String(value || "");
  if (text.length <= MAX_CAPTURE_TEXT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_CAPTURE_TEXT_LENGTH);
}

function buildSelector(element) {
  const dataTestId = element.getAttribute("data-testid");
  if (dataTestId) {
    return `${element.tagName.toLowerCase()}[data-testid="${cssEscape(dataTestId)}"]`;
  }

  const dataTest = element.getAttribute("data-test");
  if (dataTest) {
    return `${element.tagName.toLowerCase()}[data-test="${cssEscape(dataTest)}"]`;
  }

  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  }

  const path = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 5) {
    let selector = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((s) => s.tagName === current.tagName)
      : [];
    if (siblings.length > 1) {
      selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(" > ");
}

function addLocatorOption(options, strategy, value, index, tagName) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  const normalizedTag = typeof tagName === "string" ? tagName.toLowerCase() : "";
  const key = `${strategy}|${String(value)}|${index ?? ""}|${normalizedTag}`;
  if (options.some((item) => item.key === key)) {
    return;
  }

  options.push({
    key,
    strategy,
    value: String(value),
    index: Number.isInteger(index) ? index : undefined,
    tagName: normalizedTag || undefined,
    label: `${strategy}: ${truncateForLabel(value)}`
  });
}

function isVisibleElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  if (!element.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") {
    return false;
  }

  return element.getClientRects().length > 0;
}

function getIndexedCandidatesByAttr(attributeName, attributeValue, tagName) {
  const escaped = cssEscape(attributeValue);
  const tagPrefix = tagName ? `${tagName.toLowerCase()}` : "";
  const selector = tagPrefix
    ? `${tagPrefix}[${attributeName}="${escaped}"]`
    : `[${attributeName}="${escaped}"]`;

  return Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
}

function toXpathLiteral(value) {
  const text = String(value || "");
  if (!text.includes("'")) {
    return `'${text}'`;
  }
  if (!text.includes('"')) {
    return `"${text}"`;
  }

  const parts = text.split("'");
  const joined = parts.map((part) => `'${part}'`).join(",\"'\",");
  return `concat(${joined})`;
}

function buildXpathByAttribute(element, attributeName, attributeValue, index) {
  const tag = element.tagName.toLowerCase();
  const base = `//${tag}[@${attributeName}=${toXpathLiteral(attributeValue)}]`;
  if (Number.isInteger(index) && index >= 0) {
    return `(${base})[${index + 1}]`;
  }
  return base;
}

function buildLocatorOptions(element, actionText = "", optionsConfig = {}) {
  const preferTextFirst = Boolean(optionsConfig.preferTextFirst);
  const options = [];

  const textCandidate = truncateCaptureText(actionText || element.textContent || "").trim();
  if (textCandidate) {
    addLocatorOption(options, "text", textCandidate);
  }

  const dataTestId = element.getAttribute("data-testid");
  if (dataTestId) {
    const all = getIndexedCandidatesByAttr("data-testid", dataTestId, element.tagName);
    const index = all.indexOf(element);
    const hasDuplicate = all.length > 1 && index >= 0;
    addLocatorOption(options, "xpath", buildXpathByAttribute(element, "data-testid", dataTestId, hasDuplicate ? index : undefined));
    addLocatorOption(options, "data-testid", dataTestId);

    if (all.length > 1 && index >= 0) {
      addLocatorOption(options, "data-testid-index", dataTestId, index, element.tagName);
    }
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    const all = getIndexedCandidatesByAttr("aria-label", ariaLabel, element.tagName);
    const index = all.indexOf(element);
    const hasDuplicate = all.length > 1 && index >= 0;
    addLocatorOption(options, "xpath", buildXpathByAttribute(element, "aria-label", ariaLabel, hasDuplicate ? index : undefined));
    addLocatorOption(options, "aria-label", ariaLabel);

    if (all.length > 1 && index >= 0) {
      addLocatorOption(options, "aria-label-index", ariaLabel, index, element.tagName);
    }
  }

  if (element.id) {
    addLocatorOption(options, "id", element.id);
  }

  const name = element.getAttribute("name");
  if (name) {
    addLocatorOption(options, "name", name);
  }

  const activePriority = preferTextFirst
    ? ["text", ...LOCATOR_PRIORITY.filter((item) => item !== "text")]
    : LOCATOR_PRIORITY;

  options.sort((left, right) => {
    const leftPriority = activePriority.indexOf(left.strategy);
    const rightPriority = activePriority.indexOf(right.strategy);
    return leftPriority - rightPriority;
  });

  return options;
}

function pickDefaultLocator(options, fallbackSelector) {
  if (Array.isArray(options) && options.length > 0) {
    return options[0];
  }

  return {
    key: `selector|${fallbackSelector}`,
    strategy: "selector",
    value: fallbackSelector,
    label: `selector: ${truncateForLabel(fallbackSelector)}`
  };
}

async function sendStep(step) {
  try {
    await chrome.runtime.sendMessage({ type: "SAVE_STEP", payload: step });
  } catch {
  }
}

function getCapturePageUrl() {
  try {
    if (window.top && window.top.location && /^https?:/i.test(window.top.location.href)) {
      return window.top.location.href;
    }
  } catch {
  }

  const ownUrl = window.location.href || "";
  if (/^https?:/i.test(ownUrl)) {
    return ownUrl;
  }

  const referrer = document.referrer || "";
  if (/^https?:/i.test(referrer)) {
    return referrer;
  }

  return "";
}

function getElementClassName(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  if (typeof element.className === "string") {
    return element.className.trim().replace(/\s+/g, " ").slice(0, 200);
  }

  const classAttr = String(element.getAttribute("class") || "").trim();
  return classAttr.replace(/\s+/g, " ").slice(0, 200);
}

function toPascalCase(value) {
  const words = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function getRuntimePageObjectName(pageUrl) {
  const fallback = "HomePage";
  const safeUrl = String(pageUrl || "").trim();

  if (!safeUrl) {
    const fromTitle = toPascalCase(document.title || "");
    return fromTitle ? `${fromTitle}Page` : fallback;
  }

  try {
    const parsed = new URL(safeUrl);
    const segments = parsed.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    const lastPath = segments.length > 0 ? segments[segments.length - 1] : "home";
    const withoutExtension = lastPath.replace(/\.[a-z0-9]+$/i, "");
    const clean = toPascalCase(withoutExtension || "home");
    return clean ? `${clean}Page` : fallback;
  } catch {
    const fromTitle = toPascalCase(document.title || "");
    return fromTitle ? `${fromTitle}Page` : fallback;
  }
}

function buildRuntimeStepMetadata(element, pageUrl) {
  return {
    className: getElementClassName(element),
    pageObjectName: getRuntimePageObjectName(pageUrl)
  };
}

function isTextEditable(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.isContentEditable
  );
}

function getTextValue(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }

  if (element instanceof HTMLSelectElement) {
    return getSelectDisplayText(element);
  }

  if (element.isContentEditable) {
    return (element.textContent || "").trim();
  }

  return "";
}

function getSelectDisplayText(selectElement) {
  const selectedOption = selectElement.selectedOptions?.[0];
  if (selectedOption) {
    return selectedOption.textContent?.trim() || selectedOption.value || "";
  }

  const selectedIndex = selectElement.selectedIndex;
  if (selectedIndex >= 0 && selectElement.options[selectedIndex]) {
    const option = selectElement.options[selectedIndex];
    return option.textContent?.trim() || option.value || "";
  }

  return selectElement.value || "";
}

function isFileInputElement(element) {
  return element instanceof HTMLInputElement && String(element.type || "").toLowerCase() === "file";
}

async function buildFileUploadStep(element) {
  const selector = buildSelector(element);
  const locatorOptions = buildLocatorOptions(element, "", {
    preferTextFirst: false
  });
  const selectedLocator = pickDefaultLocator(locatorOptions, selector);
  const file = element.files?.[0] || null;
  const fileName = file?.name || "";
  const fileType = file?.type || "application/octet-stream";
  const fileDataBase64 = file ? await readFileAsBase64(file) : "";
  const pageUrl = getCapturePageUrl();
  const runtimeMeta = buildRuntimeStepMetadata(element, pageUrl);

  return {
    elementName: toFriendlyName(element),
    ...runtimeMeta,
    actionType: "UploadFile",
    testData: fileName,
    uploadedFileName: fileName,
    uploadedFileType: fileType,
    fileDataBase64,
    fileSizeBytes: Number(file?.size) || 0,
    selector,
    pageUrl,
    locatorOptions,
    selectedLocator,
    waitAfterMs: 400
  };
}

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function findRecordableClickTarget(element) {
  const explicit = element.closest(
    "button, a, [role='button'], [role='link'], [role='menuitem'], [role='option'], input[type='submit'], input[type='button'], input[type='checkbox'], input[type='radio'], summary, [onclick], label[for]"
  );
  if (explicit) {
    return explicit;
  }

  const generic = element.closest("div[onclick], span[onclick], div[tabindex], span[tabindex], li[role='menuitem'], label[for]");
  if (!generic) {
    return null;
  }

  const text = (generic.innerText || generic.textContent || "").trim();
  const identifiable =
    Boolean(generic.getAttribute("aria-label")) ||
    Boolean(generic.getAttribute("id")) ||
    Boolean(generic.getAttribute("name")) ||
    Boolean(generic.getAttribute("title")) ||
    Boolean(generic.getAttribute("data-testid")) ||
    Boolean(generic.getAttribute("data-test"));

  return text || identifiable ? generic : null;
}

function extractClickLabel(clickable) {
  const aria = String(clickable.getAttribute("aria-label") || "").trim();
  if (aria) {
    return truncateCaptureText(aria);
  }

  const value = String(clickable.getAttribute("value") || "").trim();
  if (value) {
    return truncateCaptureText(value);
  }

  const title = String(clickable.getAttribute("title") || "").trim();
  if (title && title.toLowerCase() !== "no file chosen") {
    return truncateCaptureText(title);
  }

  const text = String(clickable.innerText || clickable.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  return truncateCaptureText(text);
}

function shouldSkipDuplicateClick(selector, text, pageUrl, actionType = "Click") {
  const key = `${actionType}|${selector}|${text}|${pageUrl}`;
  const now = Date.now();
  const isDuplicate = lastClickCapture.key === key && now - lastClickCapture.at <= CLICK_DEDUPE_WINDOW_MS;
  lastClickCapture = { key, at: now };
  return isDuplicate;
}

function getClickWaitAfterMs(clickable, text) {
  const combined = normalizeText(`${text || ""} ${clickable.getAttribute("aria-label") || ""} ${clickable.getAttribute("title") || ""}`);
  const looksLikeLogin = /\blog\s*in\b|\blogin\b|\bsign\s*in\b|\bsignin\b|\bauth\b|\bsubmit\b/.test(combined);
  if (looksLikeLogin || clickable.matches("input[type='submit']")) {
    return 7000;
  }
  return 400;
}

function getChoiceInputType(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  if (element instanceof HTMLInputElement) {
    const inputType = String(element.type || "").toLowerCase();
    if (inputType === "radio" || inputType === "checkbox") {
      return inputType;
    }
  }

  if (element instanceof HTMLLabelElement) {
    const htmlFor = String(element.htmlFor || "").trim();
    if (htmlFor) {
      const target = document.getElementById(htmlFor);
      if (target instanceof HTMLInputElement) {
        const targetType = String(target.type || "").toLowerCase();
        if (targetType === "radio" || targetType === "checkbox") {
          return targetType;
        }
      }
    }
  }

  const descendantChoice = element.querySelector("input[type='radio'], input[type='checkbox']");
  if (descendantChoice instanceof HTMLInputElement) {
    return String(descendantChoice.type || "").toLowerCase();
  }

  if (element.closest("label[for]")) {
    const ownerLabel = element.closest("label[for]");
    const htmlFor = String(ownerLabel?.getAttribute("for") || "").trim();
    if (htmlFor) {
      const target = document.getElementById(htmlFor);
      if (target instanceof HTMLInputElement) {
        const targetType = String(target.type || "").toLowerCase();
        if (targetType === "radio" || targetType === "checkbox") {
          return targetType;
        }
      }
    }
  }

  return "";
}

function resolveChoiceControl(element, expectedType) {
  if (element instanceof HTMLInputElement && String(element.type || "").toLowerCase() === expectedType) {
    return element;
  }

  if (element instanceof HTMLLabelElement) {
    const htmlFor = String(element.htmlFor || "").trim();
    if (htmlFor) {
      const target = document.getElementById(htmlFor);
      if (target instanceof HTMLInputElement && String(target.type || "").toLowerCase() === expectedType) {
        return target;
      }
    }
  }

  if (element instanceof Element) {
    const nested = element.querySelector(`input[type='${expectedType}']`);
    if (nested instanceof HTMLInputElement) {
      return nested;
    }
  }

  return null;
}

function isTextLikeInput(element) {
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }

  const type = String(element.type || "text").toLowerCase();
  if (!type) {
    return true;
  }

  return ["text", "email", "password", "search", "tel", "url", "number"].includes(type);
}

function isRecordableValueTarget(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    return true;
  }

  if (isTextLikeInput(element)) {
    return true;
  }

  return Boolean(element.isContentEditable);
}

function shouldSkipDuplicateValueCapture(selector, value, actionType, pageUrl) {
  const key = `${actionType}|${selector}|${String(value || "")}|${pageUrl}`;
  const now = Date.now();
  const isDuplicate = lastValueCapture.key === key && now - lastValueCapture.at <= VALUE_CAPTURE_DEDUPE_WINDOW_MS;
  lastValueCapture = { key, at: now };
  return isDuplicate;
}

function captureInput(event) {
  if (!event.isTrusted) {
    return;
  }

  const element = event.target;
  if (!(element instanceof Element) || !isRecordableValueTarget(element)) {
    return;
  }

  if (isFileInputElement(element)) {
    return;
  }

  const isDropdown = element instanceof HTMLSelectElement;
  const pageUrl = getCapturePageUrl();
  const runtimeMeta = buildRuntimeStepMetadata(element, pageUrl);
  const selector = buildSelector(element);
  const value = getTextValue(element);

  if (shouldSkipDuplicateValueCapture(selector, value, isDropdown ? "Dropdown" : "Text", pageUrl)) {
    return;
  }

  const locatorOptions = buildLocatorOptions(element, isDropdown ? getSelectDisplayText(element) : "", {
    preferTextFirst: isDropdown
  });
  const selectedLocator = pickDefaultLocator(locatorOptions, selector);

  sendStep({
    elementName: toFriendlyName(element),
    ...runtimeMeta,
    actionType: isDropdown ? "Dropdown" : "Text",
    testData: value,
    selector,
    pageUrl,
    locatorOptions,
    selectedLocator
  });
}

function captureChange(event) {
  if (!event.isTrusted) {
    return;
  }

  const element = event.target;
  if (!(element instanceof Element)) {
    return;
  }

  if (isFileInputElement(element)) {
    buildFileUploadStep(element)
      .then((step) => sendStep(step))
      .catch(() => {
      });
    return;
  }

  if (isRecordableValueTarget(element)) {
    const isDropdown = element instanceof HTMLSelectElement;
    const pageUrl = getCapturePageUrl();
    const runtimeMeta = buildRuntimeStepMetadata(element, pageUrl);
    const selector = buildSelector(element);
    const value = getTextValue(element);

    if (shouldSkipDuplicateValueCapture(selector, value, isDropdown ? "Dropdown" : "Text", pageUrl)) {
      return;
    }

    const locatorOptions = buildLocatorOptions(element, isDropdown ? getSelectDisplayText(element) : "", {
      preferTextFirst: isDropdown
    });
    const selectedLocator = pickDefaultLocator(locatorOptions, selector);

    sendStep({
      elementName: toFriendlyName(element),
      ...runtimeMeta,
      actionType: isDropdown ? "Dropdown" : "Text",
      testData: value,
      selector,
      pageUrl,
      locatorOptions,
      selectedLocator
    });
  }
}

function captureClick(event) {
  if (!event.isTrusted) {
    return;
  }

  const element = event.target;
  if (!(element instanceof Element)) {
    return;
  }

  const clickable = findRecordableClickTarget(element);
  if (!clickable) {
    return;
  }

  if (clickable instanceof HTMLInputElement) {
    const inputType = String(clickable.type || "").toLowerCase();
    const isChoiceControl = inputType === "radio" || inputType === "checkbox";
    if (isChoiceControl && !isVisibleElement(clickable)) {
      return;
    }
  }

  const text = extractClickLabel(clickable);
  const choiceType = getChoiceInputType(clickable) || getChoiceInputType(element);
  let actionType = "Click";
  if (/logout|signout|log out/i.test(text)) {
    actionType = "ClickLogout";
  } else if (choiceType === "radio") {
    actionType = "Radio";
  } else if (choiceType === "checkbox") {
    actionType = "Checkbox";
  }
  const selector = buildSelector(clickable);
  const pageUrl = getCapturePageUrl();
  const runtimeMeta = buildRuntimeStepMetadata(clickable, pageUrl);
  if (shouldSkipDuplicateClick(selector, text, pageUrl, actionType)) {
    return;
  }

  const locatorOptions = buildLocatorOptions(clickable, text);
  const selectedLocator = pickDefaultLocator(locatorOptions, selector);

  sendStep({
    elementName: text || toFriendlyName(clickable),
    ...runtimeMeta,
    actionType,
    testData: text,
    selector,
    pageUrl,
    locatorOptions,
    selectedLocator,
    waitAfterMs: getClickWaitAfterMs(clickable, text)
  });
}

async function setupRecorder() {
  let isRecording = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STEPS" });
    isRecording = Boolean(response?.isRecording);
  } catch {
    try {
      const local = await chrome.storage.local.get("isRecording");
      isRecording = Boolean(local?.isRecording);
    } catch {
      isRecording = false;
    }
  }

  if (isRecording && !recorderState.attached) {
    document.addEventListener("input", captureInput, true);
    document.addEventListener("change", captureChange, true);
    document.addEventListener("click", captureClick, true);
    recorderState.attached = true;
  }

  if (!isRecording && recorderState.attached) {
    document.removeEventListener("input", captureInput, true);
    document.removeEventListener("change", captureChange, true);
    document.removeEventListener("click", captureClick, true);
    recorderState.attached = false;
  }
}

async function waitForStepCondition(step, timeoutMs) {
  const condition = String(step?.waitCondition || "afterDelay").trim().toLowerCase();
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : 0;

  if (condition !== "untilelementvisible") {
    return { ok: true, waitedMs: 0, condition: "afterDelay" };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeout) {
    const element = findElementNow(step);
    if (element && isVisibleElement(element)) {
      return { ok: true, waitedMs: Date.now() - startedAt, condition: "untilElementVisible" };
    }

    await sleep(120);
  }

  return {
    ok: false,
    reason: "wait-until-visible-timeout",
    waitedMs: timeout,
    condition: "untilElementVisible"
  };
}

if (isPrimaryRecorderInstance) {
  if (!recorderState.listenersBound) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, "isRecording")) {
        setupRecorder();
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "REPLAY_STEPS") {
        replaySteps(message.payload?.steps || [])
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse({ ok: false, error: String(error) }));
        return true;
      }

      if (message?.type === "REPLAY_SINGLE_STEP") {
        replaySingleStep(message.payload?.step)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ executed: false, reason: `script-error:${String(error)}` }));
        return true;
      }

      if (message?.type === "WAIT_FOR_STEP_CONDITION") {
        waitForStepCondition(message.payload?.step, message.payload?.timeoutMs)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, reason: `wait-condition-error:${String(error)}` }));
        return true;
      }

      if (message?.type === "COLLECT_REQUIRED_FORM_FIELDS") {
        const fields = collectRequiredFormFields();
        sendResponse({ fields });
        return false;
      }

      if (message?.type === "APPLY_REQUIRED_FIELD_FILLS") {
        applyRequiredFieldFills(message.payload?.fills)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ applied: 0, error: String(error) }));
        return true;
      }

      if (message?.type === "GET_AGENT_SCREEN_STATE") {
        sendResponse(getAgentScreenState());
        return false;
      }

      if (message?.type === "EXECUTE_AGENT_ACTION") {
        executeAgentAction(message.payload?.action)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ executed: false, reason: String(error) }));
        return true;
      }
    });

    recorderState.listenersBound = true;
  }

  setupRecorder();
}

async function replaySteps(steps) {
  for (const step of steps) {
    await replaySingleStep(step);
    await sleep(350);
  }
}

async function replaySingleStep(step) {
  if (isAssertionAction(step)) {
    return performAssertionStep(step);
  }

  if (String(step?.actionType || "").toLowerCase() === "wait") {
    return { executed: true };
  }

  const selector = step?.selector;
  if (!selector) {
    return { executed: false, reason: "missing-selector" };
  }

  const element = await findElementWithRetry(step, 15000, 200);
  if (!element) {
    return {
      executed: false,
      reason: "element-not-found"
    };
  }

  const uploadInput = resolveReplayUploadInput(step, element);
  if (uploadInput && shouldReplayAsFileUpload(step, element)) {
    return applyReplayFileUpload(step, uploadInput);
  }

  if (step.actionType === "Text" && isTextEditable(element)) {
    const value = pickValue(step);
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { executed: true };
  } else if (step.actionType === "Dropdown" && element instanceof HTMLSelectElement) {
    const value = pickValue(step);
    const applied = applyDropdownValue(element, value);
    if (!applied) {
      return { executed: false, reason: "dropdown-option-not-found" };
    }
    element.focus();
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { executed: true };
  } else if (step.actionType === "Radio") {
    const radioInput = resolveChoiceControl(element, "radio") || (element instanceof HTMLInputElement && element.type === "radio" ? element : null);
    if (!radioInput) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { executed: true };
    }

    radioInput.checked = true;
    radioInput.dispatchEvent(new Event("input", { bubbles: true }));
    radioInput.dispatchEvent(new Event("change", { bubbles: true }));
    radioInput.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { executed: true };
  } else if (step.actionType === "Checkbox") {
    const checkboxInput = resolveChoiceControl(element, "checkbox") || (element instanceof HTMLInputElement && element.type === "checkbox" ? element : null);
    if (!checkboxInput) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return { executed: true };
    }

    const targetValue = String(step?.testData || "").trim().toLowerCase();
    const shouldCheck = targetValue ? !["false", "off", "unchecked", "0", "no"].includes(targetValue) : true;
    checkboxInput.checked = shouldCheck;
    checkboxInput.dispatchEvent(new Event("input", { bubbles: true }));
    checkboxInput.dispatchEvent(new Event("change", { bubbles: true }));
    checkboxInput.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { executed: true };
  } else if (step.actionType === "Click" || step.actionType === "ClickLogout") {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { executed: true };
  }

  return { executed: false, reason: "unsupported-action" };
}

function isAssertionAction(step) {
  return String(step?.actionType || "").toLowerCase() === "assert";
}

function normalizeAssertion(step) {
  const input = step?.assertion || {};
  const type = String(input.type || "textContains").trim();

  return {
    type: type || "textContains",
    expected: String(input.expected ?? step?.testData ?? ""),
    attribute: String(input.attribute || ""),
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) && Number(input.timeoutMs) >= 250 ? Number(input.timeoutMs) : 8000,
    pollIntervalMs:
      Number.isFinite(Number(input.pollIntervalMs)) && Number(input.pollIntervalMs) >= 50
        ? Number(input.pollIntervalMs)
        : 250,
    negate: Boolean(input.negate)
  };
}

function assertionNeedsElement(assertion) {
  return !["urlContains", "titleContains"].includes(assertion.type);
}

function buildAssertionFailureReason(code, details, expected, actual) {
  const extra = [];
  if (expected !== undefined && expected !== null && String(expected) !== "") {
    extra.push(`expected=${String(expected)}`);
  }
  if (actual !== undefined && actual !== null && String(actual) !== "") {
    extra.push(`actual=${String(actual)}`);
  }
  if (details) {
    extra.push(String(details));
  }

  return extra.length > 0 ? `${code}:${extra.join(" | ")}` : code;
}

function getAssertionActual(assertion, element) {
  if (assertion.type === "urlContains") {
    return String(window.location.href || "");
  }

  if (assertion.type === "titleContains") {
    return String(document.title || "");
  }

  if (!(element instanceof Element)) {
    return "";
  }

  if (assertion.type === "exists" || assertion.type === "visible") {
    return "true";
  }

  if (assertion.type === "valueEquals") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return String(element.value || "");
    }
    return String(element.getAttribute("value") || "");
  }

  if (assertion.type === "attributeEquals") {
    const name = String(assertion.attribute || "").trim();
    if (!name) {
      return "";
    }
    return String(element.getAttribute(name) || "");
  }

  return String(element.textContent || "").replace(/\s+/g, " ").trim();
}

function evaluateAssertion(assertion, element) {
  if (assertion.type === "visible") {
    return {
      pass: isVisibleElement(element),
      actual: isVisibleElement(element) ? "visible" : "not-visible",
      expected: "visible",
      details: "visibility check"
    };
  }

  if (assertion.type === "exists") {
    return {
      pass: element instanceof Element,
      actual: element instanceof Element ? "exists" : "missing",
      expected: "exists",
      details: "existence check"
    };
  }

  const actual = getAssertionActual(assertion, element);
  const expected = String(assertion.expected || "");
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);

  if (assertion.type === "textEquals" || assertion.type === "valueEquals" || assertion.type === "attributeEquals") {
    return {
      pass: normalizedActual === normalizedExpected,
      actual,
      expected,
      details: `${assertion.type} check`
    };
  }

  if (assertion.type === "urlContains" || assertion.type === "titleContains" || assertion.type === "textContains") {
    return {
      pass: normalizedActual.includes(normalizedExpected),
      actual,
      expected,
      details: `${assertion.type} check`
    };
  }

  return {
    pass: false,
    actual,
    expected,
    details: `unsupported assertion type '${assertion.type}'`
  };
}

async function performAssertionStep(step) {
  const assertion = normalizeAssertion(step);
  if (["textEquals", "textContains", "valueEquals", "attributeEquals", "urlContains", "titleContains"].includes(assertion.type)) {
    if (!String(assertion.expected || "").trim()) {
      return { executed: false, reason: "assertion-missing-expected" };
    }
  }

  const start = Date.now();
  let sawElement = !assertionNeedsElement(assertion);
  let lastOutcome = null;

  while (Date.now() - start <= assertion.timeoutMs) {
    const element = assertionNeedsElement(assertion) ? findElementNow(step) : null;
    if (assertionNeedsElement(assertion) && element instanceof Element) {
      sawElement = true;
    }

    if (!assertionNeedsElement(assertion) || element instanceof Element) {
      const outcome = evaluateAssertion(assertion, element);
      lastOutcome = outcome;
      const pass = assertion.negate ? !outcome.pass : outcome.pass;
      if (pass) {
        return { executed: true };
      }

      if (assertion.timeoutMs <= assertion.pollIntervalMs) {
        return {
          executed: false,
          reason: buildAssertionFailureReason("assertion-failed", outcome.details, outcome.expected, outcome.actual)
        };
      }
    }

    await sleep(assertion.pollIntervalMs);
  }

  if (assertionNeedsElement(assertion) && !sawElement) {
    return { executed: false, reason: "assertion-target-not-found" };
  }

  return {
    executed: false,
    reason: buildAssertionFailureReason(
      "assertion-timeout",
      lastOutcome?.details,
      lastOutcome?.expected ?? assertion.expected,
      lastOutcome?.actual
    )
  };
}

function shouldReplayAsFileUpload(step, element) {
  if (String(step?.replayFileBase64 || "").trim()) {
    return true;
  }

  return isReplayFileUploadStep(step, element) || looksLikeUploadTrigger(step, element);
}

function resolveReplayUploadInput(step, element) {
  if (isFileInputElement(element)) {
    return element;
  }

  if (!looksLikeUploadTrigger(step, element) && !String(step?.replayFileBase64 || "").trim()) {
    return null;
  }

  if (element instanceof HTMLLabelElement || String(element?.tagName || "").toLowerCase() === "label") {
    const forId = String(element.htmlFor || "").trim();
    if (forId) {
      const linked = document.getElementById(forId);
      if (isFileInputElement(linked)) {
        return linked;
      }
    }
  }

  const nested = element.querySelector("input[type='file']");
  if (isFileInputElement(nested)) {
    return nested;
  }

  const labelParent = element.closest("label");
  if (labelParent) {
    const labelInput = labelParent.querySelector("input[type='file']");
    if (isFileInputElement(labelInput)) {
      return labelInput;
    }
  }

  const container = element.closest("form, section, [role='region'], [data-testid], .field-item, .content-item, div");
  if (container) {
    const containerInput = container.querySelector("input[type='file']");
    if (isFileInputElement(containerInput)) {
      return containerInput;
    }
  }

  const fallback = document.querySelector("input[type='file']");
  return isFileInputElement(fallback) ? fallback : null;
}

function isReplayFileUploadStep(step, element) {
  if (!isFileInputElement(element)) {
    return false;
  }

  const actionType = String(step?.actionType || "").toLowerCase();
  if (actionType === "uploadfile") {
    return true;
  }

  const testData = String(step?.testData || "").toLowerCase();
  return testData.includes("fakepath") || /\\[^\\]+\.[a-z0-9]{2,8}$/i.test(testData);
}

function looksLikeUploadTrigger(step, element) {
  const actionType = String(step?.actionType || "").toLowerCase();
  if (actionType !== "click" && actionType !== "text" && actionType !== "uploadfile") {
    return false;
  }

  // Never treat generic text/dropdown steps as file upload unless they carry explicit file hints.
  const testData = String(step?.testData || "").toLowerCase();
  if (actionType !== "uploadfile" && !(testData.includes("fakepath") || /\.[a-z0-9]{2,8}$/i.test(testData))) {
    return false;
  }

  const stepHint = `${step?.elementName || ""} ${step?.testData || ""}`.toLowerCase();
  const elementHint = `${element?.textContent || ""} ${element?.getAttribute?.("aria-label") || ""} ${element?.getAttribute?.("title") || ""}`.toLowerCase();
  const combined = `${stepHint} ${elementHint}`;

  return /\bupload\b|\bbrowse\b|\bchoose file\b|\bselect file\b/.test(combined);
}

function applyReplayFileUpload(step, element) {
  const base64 = String(step?.replayFileBase64 || "").trim();
  if (!base64) {
    return { executed: false, reason: "missing-upload-file" };
  }

  try {
    const fileName = String(step?.replayFileName || step?.uploadedFileName || step?.testData || "upload.pdf");
    const fileType = String(step?.replayFileType || "application/octet-stream");
    const file = createFileFromBase64(base64, fileName, fileType);

    const transfer = new DataTransfer();
    transfer.items.add(file);
    element.files = transfer.files;

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { executed: true };
  } catch {
    return { executed: false, reason: "upload-file-apply-failed" };
  }
}

function createFileFromBase64(base64, fileName, fileType) {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], fileName, { type: fileType });
}

function applyDropdownValue(selectElement, inputValue) {
  const target = String(inputValue ?? "").trim();
  if (!target) {
    return false;
  }

  const options = Array.from(selectElement.options || []);
  const byText = options.find((option) => normalizeText(option.textContent || "") === normalizeText(target));
  if (byText) {
    selectElement.value = byText.value;
    return true;
  }

  const byValue = options.find((option) => String(option.value) === target);
  if (byValue) {
    selectElement.value = byValue.value;
    return true;
  }

  return false;
}

async function findElementWithRetry(step, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const element = findElementNow(step);
    if (element) {
      return element;
    }
    await sleep(intervalMs);
  }
  return null;
}

function findElementNow(step) {
  const bySelectedLocator = findBySelectedLocator(step?.selectedLocator);
  if (bySelectedLocator) {
    return bySelectedLocator;
  }

  const selectors = getCandidateSelectors(step);
  for (const candidate of selectors) {
    try {
      const found = document.querySelector(candidate);
      if (found) {
        return found;
      }
    } catch {
    }
  }

  const byActionText = findByActionText(step);
  if (byActionText) {
    return byActionText;
  }

  const byElementName = findByElementName(step);
  if (byElementName) {
    return byElementName;
  }

  return null;
}

function findBySelectedLocator(locator) {
  if (!locator || !locator.strategy || !locator.value) {
    return null;
  }

  const strategy = locator.strategy;
  const value = locator.value;

  try {
    if (strategy === "text") {
      return findByTextValue(value);
    }

    if (strategy === "xpath") {
      return findByXpath(value);
    }

    if (strategy === "data-testid") {
      return document.querySelector(`[data-testid="${cssEscape(value)}"]`);
    }

    if (strategy === "data-testid-index") {
      const all = getIndexedCandidatesByAttr("data-testid", value, locator.tagName);
      return all[Number(locator.index) || 0] || null;
    }

    if (strategy === "aria-label") {
      return document.querySelector(`[aria-label="${cssEscape(value)}"]`);
    }

    if (strategy === "aria-label-index") {
      const all = getIndexedCandidatesByAttr("aria-label", value, locator.tagName);
      return all[Number(locator.index) || 0] || null;
    }

    if (strategy === "id") {
      return document.getElementById(value);
    }

    if (strategy === "name") {
      return document.querySelector(`[name="${cssEscape(value)}"]`);
    }

    if (strategy === "selector") {
      if (isLikelyXpath(value)) {
        return findByXpath(value);
      }
      return document.querySelector(value);
    }
  } catch {
    return null;
  }

  return null;
}

function isLikelyXpath(value) {
  const text = String(value || "").trim();
  return text.startsWith("//") || text.startsWith("/") || text.startsWith("(");
}

function findByXpath(xpath) {
  try {
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
  } catch {
    return null;
  }
}

function findByTextValue(value) {
  const needle = normalizeText(value);
  if (!needle) {
    return null;
  }

  const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link'], [role='menuitem'], [role='option'], label"));
  let containsMatch = null;

  for (const node of nodes) {
    const text = normalizeText(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "");
    if (text === needle) {
      return node;
    }

    if (!containsMatch && text.includes(needle)) {
      containsMatch = node;
    }
  }

  return containsMatch;
}

function getCandidateSelectors(step) {
  const candidates = [];
  const selector = typeof step?.selector === "string" ? step.selector.trim() : "";
  if (selector) {
    candidates.push(selector);
  }

  const elementName = typeof step?.elementName === "string" ? step.elementName.trim() : "";
  if (elementName) {
    const escaped = cssEscape(elementName);
    candidates.push(`#${escaped}`);
    candidates.push(`[name="${escaped}"]`);
    candidates.push(`[aria-label="${escaped}"]`);
    candidates.push(`[placeholder="${escaped}"]`);
    candidates.push(`[title="${escaped}"]`);
  }

  return Array.from(new Set(candidates));
}

function findByActionText(step) {
  const raw = typeof step?.testData === "string" ? step.testData : "";
  const needle = normalizeText(raw);
  if (!needle) {
    return null;
  }

  const clickableNodes = Array.from(
    document.querySelectorAll("button, a, [role='button'], [role='link'], input[type='button'], input[type='submit'], label")
  );

  let containsMatch = null;
  for (const node of clickableNodes) {
    const text = normalizeText(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "");
    if (!text) {
      continue;
    }

    if (text === needle) {
      return node;
    }

    if (!containsMatch && text.includes(needle)) {
      containsMatch = node;
    }
  }

  return containsMatch;
}

function findByElementName(step) {
  const raw = typeof step?.elementName === "string" ? step.elementName : "";
  const needle = normalizeText(raw);
  if (!needle) {
    return null;
  }

  const fields = Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']"));
  for (const node of fields) {
    const label = normalizeText(
      node.getAttribute("aria-label") ||
        node.getAttribute("name") ||
        node.getAttribute("id") ||
        node.getAttribute("placeholder") ||
        node.getAttribute("title") ||
        ""
    );

    if (label && (label === needle || label.includes(needle) || needle.includes(label))) {
      return node;
    }
  }

  return null;
}

function pickValue(step) {
  if (Object.prototype.hasOwnProperty.call(step || {}, "replayTestData")) {
    return step.replayTestData ?? "";
  }

  if (Array.isArray(step.variants) && step.variants.length > 0) {
    const index = Number.isInteger(step.nextVariantIndex) ? step.nextVariantIndex : 0;
    const safeIndex = index % step.variants.length;
    const chosen = step.variants[safeIndex];
    step.nextVariantIndex = (safeIndex + 1) % step.variants.length;
    return chosen;
  }
  return step.testData ?? "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectRequiredFormFields() {
  const fields = [];
  const elements = Array.from(document.querySelectorAll("input, textarea, select"));

  for (const element of elements) {
    if (!(element instanceof Element) || !isVisibleElement(element)) {
      continue;
    }

    const required =
      element.hasAttribute("required") ||
      String(element.getAttribute("aria-required") || "").toLowerCase() === "true";

    if (!required) {
      continue;
    }

    const selector = getStableSelector(element);
    if (!selector) {
      continue;
    }

    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("name") ||
      element.getAttribute("id") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      element.tagName.toLowerCase();

    fields.push({
      selector,
      label: String(label || ""),
      tagName: element.tagName.toLowerCase(),
      type: element instanceof HTMLInputElement ? element.type || "text" : element.tagName.toLowerCase()
    });
  }

  return fields;
}

async function applyRequiredFieldFills(fills) {
  const safeFills = Array.isArray(fills) ? fills : [];
  let applied = 0;

  for (const fill of safeFills) {
    const selector = String(fill?.selector || "").trim();
    const value = String(fill?.value || "");
    if (!selector || !value) {
      continue;
    }

    let element = null;
    try {
      element = document.querySelector(selector);
    } catch {
      element = null;
    }

    if (!element || !isTextEditable(element)) {
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      if (!applyDropdownValue(element, value)) {
        continue;
      }
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    applied += 1;
    await sleep(50);
  }

  return { applied };
}

function getStableSelector(element) {
  if (!(element instanceof Element)) {
    return "";
  }

  const testId = element.getAttribute("data-testid");
  if (testId) {
    return `${element.tagName.toLowerCase()}[data-testid="${cssEscape(testId)}"]`;
  }

  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return `${element.tagName.toLowerCase()}[aria-label="${cssEscape(ariaLabel)}"]`;
  }

  return buildSelector(element);
}

function getAgentScreenState() {
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((element) => isVisibleElement(element))
    .slice(0, 60)
    .map((element) => ({
      selector: getStableSelector(element),
      label:
        element.getAttribute("aria-label") ||
        element.getAttribute("name") ||
        element.getAttribute("id") ||
        element.getAttribute("placeholder") ||
        "",
      tagName: element.tagName.toLowerCase(),
      required:
        element.hasAttribute("required") ||
        String(element.getAttribute("aria-required") || "").toLowerCase() === "true"
    }))
    .filter((item) => item.selector);

  const actions = Array.from(
    document.querySelectorAll("button, a, [role='button'], [role='link'], input[type='button'], input[type='submit']")
  )
    .filter((element) => isVisibleElement(element))
    .slice(0, 50)
    .map((element) => ({
      selector: getStableSelector(element),
      label: (element.textContent || element.getAttribute("value") || element.getAttribute("aria-label") || "").trim()
    }))
    .filter((item) => item.selector);

  return {
    title: document.title || "",
    fields,
    actions
  };
}

async function executeAgentAction(action) {
  const type = String(action?.type || "").toLowerCase();
  if (!type) {
    return { executed: false, reason: "missing-action-type" };
  }

  const selector = String(action?.selector || "").trim();
  const value = String(action?.value ?? "");

  if (type === "click") {
    const element = resolveElement(selector, action?.label);
    if (!element) {
      return { executed: false, reason: "element-not-found" };
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return { executed: true };
  }

  if (type === "fill" || type === "select") {
    const element = resolveElement(selector, action?.label);
    if (!element) {
      return { executed: false, reason: "element-not-found" };
    }

    if (element instanceof HTMLSelectElement) {
      const applied = applyDropdownValue(element, value);
      if (!applied) {
        return { executed: false, reason: "dropdown-option-not-found" };
      }
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      element.value = value;
    } else if (element.isContentEditable) {
      element.focus();
      element.textContent = value;
    } else {
      return { executed: false, reason: "unsupported-fill-target" };
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { executed: true };
  }

  return { executed: false, reason: `unsupported-action:${type}` };
}

function resolveElement(selector, fallbackLabel) {
  if (selector) {
    try {
      const found = document.querySelector(selector);
      if (found) {
        return found;
      }
    } catch {
    }
  }

  const normalizedLabel = normalizeText(fallbackLabel || "");
  if (!normalizedLabel) {
    return null;
  }

  const candidates = Array.from(document.querySelectorAll("input, textarea, select, button, a, [role='button'], [role='link']"));
  for (const candidate of candidates) {
    if (!isVisibleElement(candidate)) {
      continue;
    }

    const label = normalizeText(
      candidate.getAttribute("aria-label") ||
        candidate.getAttribute("name") ||
        candidate.getAttribute("id") ||
        candidate.getAttribute("placeholder") ||
        candidate.textContent ||
        candidate.getAttribute("value") ||
        ""
    );

    if (label && (label === normalizedLabel || label.includes(normalizedLabel) || normalizedLabel.includes(label))) {
      return candidate;
    }
  }

  return null;
}

