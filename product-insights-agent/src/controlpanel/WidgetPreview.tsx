"use client";

import { useEffect, useRef } from "react";

interface Props {
  productId: string;
}

const WIDGET_SCRIPT_ID = "pi-widget-script";
const WIDGET_CSS_ID = "pi-widget-css";

function loadWidgetAssets(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!document.getElementById(WIDGET_CSS_ID)) {
      const link = document.createElement("link");
      link.id = WIDGET_CSS_ID;
      link.rel = "stylesheet";
      link.href = "/widget/widget.css";
      document.head.appendChild(link);
    }

    if (window.ProductInsightsWidget) {
      resolve();
      return;
    }

    const existing = document.getElementById(WIDGET_SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = WIDGET_SCRIPT_ID;
    script.src = "/widget/widget.js";
    script.onload = () => resolve();
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

export function WidgetPreview({ productId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !productId) return;
    const el = containerRef.current;
    el.innerHTML = "";

    let cancelled = false;
    loadWidgetAssets()
      .then(() => {
        if (cancelled) return;
        window.ProductInsightsWidget.init({
          productId,
          apiBase: "",
          container: el,
        });
      })
      .catch((err) => {
        console.error("[ControlPanel] widget load error:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  return (
    <div className="rounded-lg bg-white p-4 shadow-md">
      <h2 className="mb-4 font-semibold text-zinc-900">
        Widget Preview (Production Build)
      </h2>
      <div ref={containerRef} />
    </div>
  );
}
