import { widgetConfig } from "./config";
import { fetchSeedQuestions } from "./api";
import { streamChat } from "./stream";
import { buildWidgetHTML, buildModal, renderMarkdown } from "./render";
import { getSessionId } from "./session";
import { createEmitter } from "./emit";
import type { SeedQuestion, WidgetConfig } from "./types";

declare global {
  interface Window {
    ProductInsightsWidget: { init: (config: WidgetConfig) => void };
    PRODUCT_INSIGHTS_CONFIG?: { apiBase?: string };
  }
}

function getFallbackQuestions(productId: string): SeedQuestion[] {
  return widgetConfig.seedQuestions.fallback
    .slice(0, widgetConfig.seedQuestions.displayCount)
    .map((text, i) => ({ id: `fallback-${i}`, text, productId }));
}

function renderSkeletons(container: HTMLElement) {
  container.innerHTML = "";
  const widths = ["w-72", "w-64", "w-80"];
  for (let i = 0; i < widgetConfig.seedQuestions.displayCount; i++) {
    const skel = document.createElement("div");
    skel.className = `pi-skeleton ${widths[i] ?? ""}`;
    container.appendChild(skel);
  }
}

function renderPills(
  container: HTMLElement,
  questions: SeedQuestion[],
  onClick: (q: SeedQuestion) => void,
  disabled: boolean,
  animated = false,
) {
  container.innerHTML = "";
  questions.forEach((q, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pi-pill" + (animated ? " widget-fade-in" : "");
    if (animated) btn.style.animationDelay = `${i * 120}ms`;
    btn.textContent = q.text;
    btn.disabled = disabled;
    btn.addEventListener("click", () => onClick(q));
    container.appendChild(btn);
  });
}

function init(config: WidgetConfig) {
  const apiBase =
    config.apiBase ?? window.PRODUCT_INSIGHTS_CONFIG?.apiBase ?? "";
  const { productId, secret } = config;

  const sessionId = getSessionId();
  const emit = createEmitter({
    apiBase,
    sessionId,
    clientId: config.clientId,
    productId,
    secret,
  });

  const mountTarget =
    config.container ??
    (document.querySelector<HTMLElement>('[data-widget="product-insights"]') ||
      document.body);

  const root = buildWidgetHTML();
  mountTarget.appendChild(root);

  const idlePanel = root.querySelector<HTMLElement>(".pi-idle-panel")!;
  const activePanel = root.querySelector<HTMLElement>(".pi-active-panel")!;
  const pillsContainer = root.querySelector<HTMLElement>(
    ".pi-idle-panel .pi-pills",
  )!;
  const idleForm = root.querySelector<HTMLFormElement>(
    ".pi-idle-panel .pi-form",
  )!;
  const idleInput = idleForm.querySelector<HTMLInputElement>(".pi-input")!;
  const idleSubmit = idleForm.querySelector<HTMLButtonElement>(".pi-submit")!;
  const questionEl = root.querySelector<HTMLElement>(".pi-question")!;
  const answerEl = root.querySelector<HTMLElement>(".pi-answer")!;
  const disclaimerLink = root.querySelector<HTMLElement>(
    ".pi-disclaimer-link",
  )!;
  const followupSection = root.querySelector<HTMLElement>(".pi-followup")!;
  const followupPillsContainer = root.querySelector<HTMLElement>(
    ".pi-followup .pi-pills",
  )!;
  const followupForm = root.querySelector<HTMLFormElement>(
    ".pi-followup .pi-form",
  )!;
  const followupInput =
    followupForm.querySelector<HTMLInputElement>(".pi-input")!;
  const followupSubmit =
    followupForm.querySelector<HTMLButtonElement>(".pi-submit")!;

  const clickedIds: string[] = [];
  let seedQuestions: SeedQuestion[] = [];
  let isStreaming = false;

  let loadingInterval: ReturnType<typeof setInterval> | null = null;
  let loadingIndex = 0;
  let loadingVisible = true;

  function setFormsDisabled(disabled: boolean) {
    idleInput.disabled = disabled;
    idleSubmit.disabled = disabled;
    followupInput.disabled = disabled;
    followupSubmit.disabled = disabled;
  }

  function startLoadingCycle() {
    loadingIndex = 0;
    loadingVisible = true;
    answerEl.innerHTML = `<strong>A:</strong> <span class="widget-loading-text pi-loading-span">${widgetConfig.loadingMessages[0]}</span>`;
    loadingInterval = setInterval(() => {
      const span = answerEl.querySelector<HTMLElement>(".pi-loading-span");
      if (span) span.style.opacity = "0";
      setTimeout(() => {
        loadingIndex = (loadingIndex + 1) % widgetConfig.loadingMessages.length;
        loadingVisible = true;
        const span2 = answerEl.querySelector<HTMLElement>(".pi-loading-span");
        if (span2) {
          span2.textContent = widgetConfig.loadingMessages[loadingIndex];
          span2.style.opacity = "1";
        }
      }, 300);
    }, 1500);
  }

  function stopLoadingCycle() {
    if (loadingInterval !== null) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
    void loadingVisible;
  }

  function loadSeedQuestions(forFollowup = false, currentQuestion = "") {
    if (!forFollowup) {
      renderSkeletons(pillsContainer);
      idleForm.style.display = "none";
    }
    fetchSeedQuestions(apiBase, productId, clickedIds, secret)
      .then(({ questions, source }) => {
        seedQuestions = questions;
        if (!forFollowup) {
          emit("seed_questions_loaded", {
            count: questions.length,
            source,
          });
          renderPills(
            pillsContainer,
            questions,
            (q) => submitQuestion(q.text, q.id),
            isStreaming,
          );
          idleForm.style.display = "";
        } else {
          const followups = questions
            .filter((q) => q.text !== currentQuestion)
            .slice(0, 3);
          renderPills(
            followupPillsContainer,
            followups,
            (q) => submitQuestion(q.text, q.id),
            false,
            true,
          );
          followupSection.style.display = "block";
          setFormsDisabled(false);
          idleSubmit.disabled = !idleInput.value.trim();
          followupSubmit.disabled = !followupInput.value.trim();
        }
      })
      .catch(() => {
        seedQuestions = getFallbackQuestions(productId);
        if (!forFollowup) {
          emit("seed_questions_loaded", {
            count: seedQuestions.length,
            source: "fallback",
          });
          renderPills(
            pillsContainer,
            seedQuestions,
            (q) => submitQuestion(q.text, q.id),
            isStreaming,
          );
          idleForm.style.display = "";
        }
      });
  }

  function showActive(questionText: string) {
    idlePanel.style.display = "none";
    activePanel.style.display = "block";
    followupSection.style.display = "none";
    disclaimerLink.style.display = "none";
    questionEl.innerHTML = `<strong>Q:</strong> ${document.createTextNode(questionText).nodeValue ?? questionText}`;
    answerEl.innerHTML = "";
    setFormsDisabled(true);
    startLoadingCycle();
  }

  function submitQuestion(text: string, seedId?: string) {
    if (isStreaming || !text.trim()) return;
    const firstTurn = clickedIds.length === 0;
    const submitSource: "seed" | "followup" | "free_text" = seedId
      ? firstTurn
        ? "seed"
        : "followup"
      : "free_text";
    emit("question_submitted", {
      source: submitSource,
      questionId: seedId,
    });
    if (seedId && !clickedIds.includes(seedId)) clickedIds.push(seedId);
    isStreaming = true;
    const startTime = Date.now();
    showActive(text);

    let accumulated = "";
    let firstChunk = true;

    streamChat(
      `${apiBase}/api/chat`,
      { message: text, productId },
      {
        onChunk(delta) {
          if (firstChunk) {
            firstChunk = false;
            emit("answer_started", {});
            stopLoadingCycle();
            answerEl.innerHTML =
              '<strong>A:</strong> <span class="widget-answer"></span><span class="widget-cursor"></span>';
          }
          accumulated += delta;
          const answerSpan =
            answerEl.querySelector<HTMLElement>(".widget-answer");
          if (answerSpan) answerSpan.textContent = accumulated;
        },
        onDone(fullText, escalationCategory) {
          stopLoadingCycle();
          isStreaming = false;
          const answerSpan =
            answerEl.querySelector<HTMLElement>(".widget-answer");
          const cursor = answerEl.querySelector<HTMLElement>(".widget-cursor");
          if (cursor) cursor.remove();
          if (answerSpan)
            answerSpan.innerHTML = renderMarkdown(fullText || accumulated);
          disclaimerLink.style.display = "block";
          if (escalationCategory) {
            const cta = document.createElement("div");
            cta.className = "pi-escalation-cta";
            cta.textContent =
              "Connect with a specialist for personalized assistance.";
            answerEl.appendChild(cta);
          }
          emit("answer_completed", {
            durationMs: Date.now() - startTime,
            escalation: !!escalationCategory,
          });
          loadSeedQuestions(true, text);
        },
        onError(err) {
          stopLoadingCycle();
          isStreaming = false;
          console.error("[ProductInsightsWidget] stream error:", err);
          answerEl.innerHTML =
            '<strong>A:</strong> <span class="pi-error">Sorry, something went wrong. Please try again.</span>';
          setFormsDisabled(false);
          emit("answer_error", {
            message: err instanceof Error ? err.message : String(err),
          });
        },
      },
      secret,
    );
  }

  idleForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = idleInput.value.trim();
    if (!val) return;
    idleInput.value = "";
    submitQuestion(val);
  });

  idleInput.addEventListener("input", () => {
    idleSubmit.disabled = !idleInput.value.trim();
  });
  idleSubmit.disabled = true;

  followupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = followupInput.value.trim();
    if (!val) return;
    followupInput.value = "";
    submitQuestion(val);
  });

  followupInput.addEventListener("input", () => {
    followupSubmit.disabled = !followupInput.value.trim();
  });
  followupSubmit.disabled = true;

  disclaimerLink.addEventListener("click", openDisclaimer);
  disclaimerLink.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDisclaimer();
    }
  });

  // Post resize messages to parent when embedded in an iframe. We measure
  // the widget root's own height rather than documentElement.scrollHeight:
  // scrollHeight has a floor of the iframe viewport, so once the parent
  // grows the iframe to fit a long answer, scrollHeight can't report a
  // smaller value when subsequent content is shorter, and the container
  // never shrinks back down. rAF-debounced to coalesce streaming updates.
  // The disclaimer modal is position: fixed, so it contributes no layout
  // height and is intentionally not measured.
  if (window.parent !== window) {
    let rafId: number | null = null;
    let lastHeight = 0;
    const postHeight = () => {
      rafId = null;
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height === lastHeight || height <= 0) return;
      lastHeight = height;
      window.parent.postMessage(
        { type: "product-insights:resize", height },
        "*",
      );
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(postHeight);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    schedule();
  }

  function openDisclaimer() {
    emit("disclaimer_opened", {});
    const modal = buildModal();
    document.body.appendChild(modal);

    function close() {
      modal.remove();
      document.removeEventListener("keydown", onKey);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    modal.addEventListener("click", close);
    modal.querySelector(".pi-modal-close")?.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
  }

  loadSeedQuestions();
}

window.ProductInsightsWidget = { init };
