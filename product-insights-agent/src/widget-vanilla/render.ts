import { widgetConfig } from "./config";

export function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, "<br>");
}

export function buildModal(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "pi-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "pi-disclaimer-title");

  const card = document.createElement("div");
  card.className = "pi-modal-card";
  card.addEventListener("click", (e) => e.stopPropagation());

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pi-modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";

  const title = document.createElement("h4");
  title.id = "pi-disclaimer-title";
  title.className = "pi-modal-title";
  title.textContent = widgetConfig.disclaimerHeader;

  card.appendChild(closeBtn);
  card.appendChild(title);

  for (const paragraph of widgetConfig.disclaimer) {
    const p = document.createElement("p");
    p.className = "pi-modal-para";
    p.textContent = paragraph;
    card.appendChild(p);
  }

  overlay.appendChild(card);
  return overlay;
}

export function buildWidgetHTML(): HTMLElement {
  const root = document.createElement("div");
  root.className = "pi-widget";

  // Idle panel
  const idlePanel = document.createElement("div");
  idlePanel.className = "pi-idle-panel";

  const title = document.createElement("h3");
  title.className = "pi-title";
  title.textContent = widgetConfig.title;

  const subtitle = document.createElement("p");
  subtitle.className = "pi-subtitle";
  subtitle.textContent = widgetConfig.subtitle;

  const pillsContainer = document.createElement("div");
  pillsContainer.className = "pi-pills";

  const form = document.createElement("form");
  form.className = "pi-form";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "pi-input";
  input.placeholder = widgetConfig.inputPlaceholder;
  input.autocomplete = "off";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "pi-submit";
  submitBtn.textContent = widgetConfig.askButton;

  form.appendChild(input);
  form.appendChild(submitBtn);

  idlePanel.appendChild(subtitle);
  idlePanel.appendChild(pillsContainer);
  idlePanel.appendChild(form);

  // Active panel
  const activePanel = document.createElement("div");
  activePanel.className = "pi-active-panel";
  activePanel.style.display = "none";

  const qaBox = document.createElement("div");
  qaBox.className = "pi-qa-box";

  const questionEl = document.createElement("div");
  questionEl.className = "pi-question";

  const answerEl = document.createElement("div");
  answerEl.className = "pi-answer";

  const disclaimerLink = document.createElement("div");
  disclaimerLink.className = "pi-disclaimer-link";
  disclaimerLink.setAttribute("role", "button");
  disclaimerLink.setAttribute("tabindex", "0");
  disclaimerLink.style.display = "none";
  disclaimerLink.innerHTML = `${widgetConfig.disclaimerLinkText} <span class="pi-info-icon">i</span>`;

  qaBox.appendChild(questionEl);
  qaBox.appendChild(answerEl);
  qaBox.appendChild(disclaimerLink);

  const followupSection = document.createElement("div");
  followupSection.className = "pi-followup";
  followupSection.style.display = "none";

  const followupHeader = document.createElement("div");
  followupHeader.className = "pi-followup-header";
  followupHeader.textContent = widgetConfig.faqHeader;

  const followupPills = document.createElement("div");
  followupPills.className = "pi-pills";

  const followupFormWrap = document.createElement("div");
  followupFormWrap.className = "widget-fade-in";

  const followupForm = document.createElement("form");
  followupForm.className = "pi-form";

  const followupInput = document.createElement("input");
  followupInput.type = "text";
  followupInput.className = "pi-input";
  followupInput.placeholder = widgetConfig.inputPlaceholder;
  followupInput.autocomplete = "off";

  const followupSubmit = document.createElement("button");
  followupSubmit.type = "submit";
  followupSubmit.className = "pi-submit";
  followupSubmit.textContent = widgetConfig.askButton;

  followupForm.appendChild(followupInput);
  followupForm.appendChild(followupSubmit);
  followupFormWrap.appendChild(followupForm);

  followupSection.appendChild(followupHeader);
  followupSection.appendChild(followupPills);
  followupSection.appendChild(followupFormWrap);

  activePanel.appendChild(qaBox);
  activePanel.appendChild(followupSection);

  root.appendChild(title);
  root.appendChild(idlePanel);
  root.appendChild(activePanel);

  return root;
}
