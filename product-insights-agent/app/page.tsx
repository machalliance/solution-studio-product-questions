import { ControlPanelPage } from "@/controlpanel/ControlPanelPage";

export default function Home() {
  if (process.env.NODE_ENV === "development") {
    return <ControlPanelPage />;
  }

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#18181b",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        Product Insights — Widget Backend
      </h1>
      <p style={{ color: "#52525b" }}>
        This app serves the widget bundle, embed script, and chat API. The
        customer-facing demo PDP lives in the sibling <code>storefront/</code>{" "}
        app.
      </p>
    </main>
  );
}
