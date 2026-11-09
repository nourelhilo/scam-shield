"use strict";

const form = document.querySelector("#scan-form");
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const entries = Object.fromEntries(tabs.map((tab) => [
  tab.dataset.type,
  document.querySelector("#entry-" + tab.dataset.type),
]));
const examples = {
  text: "Your delivery is on hold. Pay a redelivery fee in the next 30 minutes at https://parcel-alert.example/release.",
  url: "https://account-verify.example/confirm-password",
  email: "Subject: Immediate action required\n\nYour account will be locked today. Reply with your password and the six-digit verification code we just sent you.",
};
const riskLabels = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  unknown: "Unknown risk",
};

const endpoint = form.dataset.analysisEndpoint.trim();
const exampleButton = document.querySelector("#example-button");
const submitButton = form.querySelector('button[type="submit"]');
const submitLabel = document.querySelector("#submit-label");
const counter = document.querySelector("#character-count");
const statusMessage = document.querySelector("#scan-status");
const result = document.querySelector("#scan-result");
let activeType = "text";
let busy = false;

function setStatus(message = "", isError = false) {
  statusMessage.classList.toggle("is-error", isError);
  statusMessage.textContent = message;
}

function refreshEntry() {
  const entry = entries[activeType];
  counter.textContent = entry.value.length.toLocaleString("en-US") + " / " + entry.maxLength.toLocaleString("en-US");
  entry.removeAttribute("aria-invalid");
  setStatus();
  result.hidden = true;
}

function activateTab(selectedTab) {
  activeType = selectedTab.dataset.type;
  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
  }
  refreshEntry();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex;
    switch (event.key) {
      case "ArrowLeft": nextIndex = (index + tabs.length - 1) % tabs.length; break;
      case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
      case "Home": nextIndex = 0; break;
      case "End": nextIndex = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    activateTab(tabs[nextIndex]);
    tabs[nextIndex].focus();
  });
}

for (const entry of Object.values(entries)) {
  entry.addEventListener("input", refreshEntry);
}

exampleButton.addEventListener("click", () => {
  const entry = entries[activeType];
  entry.value = examples[activeType];
  refreshEntry();
  entry.focus();
});

for (const trigger of document.querySelectorAll("[data-open]")) {
  trigger.addEventListener("click", () => {
    document.getElementById(trigger.dataset.open).showModal();
  });
}

function isWebUrl(content) {
  try {
    const url = new URL(content);
    return /^https?:\/\//i.test(content) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function showInputError(entry, message) {
  setStatus(message, true);
  entry.setAttribute("aria-invalid", "true");
  entry.focus();
}

function setBusy(value) {
  busy = value;
  submitButton.disabled = value;
  exampleButton.disabled = value;
  entries[activeType].readOnly = value;
  for (const tab of tabs) tab.disabled = value;
  submitLabel.textContent = value ? "Analyzing…" : "Analyze for scam";
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function renderResultList(name, items) {
  const list = document.getElementById("result-" + name);
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement("li");
    row.textContent = item;
    return row;
  }));
  document.getElementById(name + "-section").hidden = items.length === 0;
}

function renderResult(report) {
  const risk = typeof report?.risk === "string" ? report.risk.trim().toLowerCase() : "";
  if (
    !Object.hasOwn(riskLabels, risk) ||
    !isNonemptyString(report.summary) ||
    !Array.isArray(report.warnings) || !report.warnings.every(isNonemptyString) ||
    !Array.isArray(report.recommendations) || !report.recommendations.every(isNonemptyString)
  ) {
    throw new Error("The analysis service returned an unreadable result. Try again later.");
  }

  const label = document.querySelector("#risk-label");
  label.dataset.risk = risk;
  label.textContent = riskLabels[risk];
  document.querySelector("#result-summary").textContent = report.summary;
  renderResultList("warnings", report.warnings);
  renderResultList("recommendations", report.recommendations);
  result.hidden = false;
  result.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;

  const type = activeType;
  const entry = entries[type];
  const content = entry.value.trim();
  refreshEntry();

  if (!content) {
    showInputError(entry, "Paste something to check first, or try an example.");
    return;
  }
  if (entry.value.length > entry.maxLength) {
    showInputError(entry, "Shorten your entry to 2,000 characters or fewer.");
    return;
  }
  if (type === "url" && !isWebUrl(content)) {
    showInputError(entry, "Enter a full web address starting with https:// or http://.");
    return;
  }
  if (!endpoint) {
    setStatus("Analysis is unavailable in this preview. Connect the analysis service to run a check.", true);
    return;
  }

  setBusy(true);
  setStatus("Checking your submission…");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type, content }),
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status === 429) {
      setStatus("Too many checks in a short time. Wait a moment, then try again.", true);
      return;
    }
    if (!response.ok) {
      setStatus("The analysis service could not complete this check. Try again later.", true);
      return;
    }

    const report = await response.json();
    renderResult(report);
    setStatus();
  } catch {
    setStatus(
      controller.signal.aborted
        ? "The check took too long. Please try again."
        : "The analysis service did not return a usable result. Try again later.",
      true,
    );
  } finally {
    clearTimeout(timeout);
    setBusy(false);
  }
});
