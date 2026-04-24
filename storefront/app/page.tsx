"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

const THUMBS = [
  "/images/dreame-x40-ultra-0.jpg",
  "/images/dreame-x40-ultra-1.jpg",
  "/images/dreame-x40-ultra-2.jpg",
  "/images/dreame-x40-ultra-3.jpg",
];

const WIDGET_ORIGIN =
  process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? "http://localhost:3000";

const WIDGET_EMBED_SECRET = process.env.NEXT_PUBLIC_WIDGET_EMBED_SECRET ?? "";

const CLIENT_ID_COOKIE = "mb_client_id";

// Reads (or mints) an opaque analytics ID for this browser. In production,
// replace this with a lookup against your real analytics session — e.g. the
// GA4 `_ga` cookie's client_id or a Segment `anonymousId` from localStorage.
// Whatever you pass must be non-PII; it ends up in URL query strings and
// server logs. See product-insights-agent/docs/production-scaling/analytics.md.
function getClientId(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + CLIENT_ID_COOKIE + "=([^;]*)"),
  );
  if (match) return decodeURIComponent(match[1]);
  const id = crypto.randomUUID();
  document.cookie = `${CLIENT_ID_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; SameSite=Lax`;
  return id;
}

export default function Page() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [clientId, setClientId] = useState<string>("");

  useEffect(() => {
    setClientId(getClientId());
  }, []);

  return (
    <>
      <header>
        <div className="topbar">
          <div className="topbar-inner">
            <a href="/" className="brand">
              Mega<span className="italic">Buy</span>
            </a>
            <div className="search">
              <input type="search" placeholder="Search MegaBuy" />
              <button type="button" aria-label="Search">
                🔍
              </button>
            </div>
            <nav className="top-links">
              <span>Order Status</span>
              <span>Blog</span>
              <span>MegaBuy Business</span>
              <span>Stores</span>
              <span>My MegaBuy Account</span>
              <span>🛒 Cart</span>
            </nav>
          </div>
        </div>
        <div className="mainnav">
          <div className="mainnav-inner">
            <span>Shop</span>
            <span>Deals</span>
            <span>Phones &amp; Plans</span>
            <span>Outlet</span>
            <span>Services</span>
          </div>
        </div>
      </header>

      <main>
        <nav className="breadcrumbs">
          <span>Home</span>
          <span className="sep">›</span> <span>Appliances</span>
          <span className="sep">›</span> <span>Vacuums &amp; Floor Care</span>
          <span className="sep">›</span> <span>Robot Vacuums</span>
          <span className="sep">›</span>{" "}
          <span className="last">Product Details</span>
        </nav>

        <div className="explore">
          <span className="explore-label">Explore more like this</span>
          <button className="explore-pill">🔎 Robot Vacuums On Sale</button>
          <button className="explore-pill">
            🔎 Robot Vacuum Cleaner with Mop
          </button>
          <button className="explore-pill">🔎 Outlet Deals on Vacuums</button>
        </div>

        <div className="hero">
          <div className="gallery">
            <div className="gallery-thumbs">
              {THUMBS.map((src, i) => (
                <button
                  key={src}
                  className={i === activeIndex ? "active" : undefined}
                  aria-label={`Show image ${i + 1}`}
                  onClick={() => setActiveIndex(i)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`thumbnail ${i + 1}`} />
                </button>
              ))}
            </div>
            <div className="gallery-main">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={THUMBS[activeIndex]}
                alt="Dreame X40 Ultra Auto-Empty Robot Vacuum & Mop"
              />
            </div>
          </div>

          <div className="hero-meta">
            <span className="badge-deal">Top Deal</span>
            <h1 className="product-name">
              Dreame X40 Ultra Auto-Empty Robot Vacuum &amp; Mop – Black
            </h1>
            <div className="product-meta">
              <span>
                Model: <strong>X40 Ultra</strong>
              </span>
              <span>
                Web Code: <strong>19446187</strong>
              </span>
            </div>
            <span className="bought-badge">
              ⭐ 100+ bought in the last month
            </span>
            <div className="rating">
              <span className="score">4.6</span>
              <span className="stars-filled">★★★★</span>
              <span className="stars-empty">★</span>
              <a href="#reviews">(40 Reviews)</a>
            </div>
            <div className="description">
              <h2>About this product</h2>
              <p>
                The Dreame X40 Ultra is a premium robot vacuum and mop combo
                featuring advanced navigation, powerful suction, and a fully
                automated self-cleaning station. It handles vacuuming and
                mopping simultaneously with intelligent surface detection.
              </p>
            </div>

            {/* Product Insights widget — one-line embed. Injects a sandboxed iframe. */}
            <div id="product-insights-mount" />
            {clientId && (
              <Script
                src={`${WIDGET_ORIGIN}/embed.js`}
                data-product-id="dreame-x40-ultra"
                data-mount="#product-insights-mount"
                data-client-id={clientId}
                data-embed-secret={WIDGET_EMBED_SECRET}
                strategy="afterInteractive"
              />
            )}
          </div>
        </div>

        <div className="detail-tabs">
          <div className="detail-tabs-inner">
            <a href="#reviews">Reviews</a>
            <a href="#about-this-product" className="active">
              About This Product
            </a>
            <a href="#specifications">Specifications</a>
            <a href="#from-the-manufacturer">From the Manufacturer</a>
          </div>
        </div>

        <section className="panel" id="about-this-product">
          <h2>Key Features</h2>
          <ul className="features-list">
            <li>12,000Pa HyperForce suction power</li>
            <li>Auto mop lifting and removal</li>
            <li>Self-cleaning, self-emptying, self-refilling base station</li>
            <li>3D structured light obstacle avoidance</li>
            <li>AI-powered navigation with LiDAR</li>
            <li>Hot water mop washing up to 70°C</li>
            <li>Auto detergent dispensing</li>
            <li>Edge-to-edge mopping with MopExtend RoboSwing</li>
            <li>Multi-floor mapping support</li>
            <li>Voice assistant compatible (Alexa, Google Home)</li>
          </ul>
        </section>

        <section className="panel" id="specifications">
          <h2>Specifications</h2>
          <div className="specs">
            <div className="specs-row">
              <span className="label">Suction Power</span>
              <span className="value">12,000Pa</span>
            </div>
            <div className="specs-row">
              <span className="label">Battery Capacity</span>
              <span className="value">6,400mAh</span>
            </div>
            <div className="specs-row">
              <span className="label">Run Time</span>
              <span className="value">Up to 210 minutes</span>
            </div>
            <div className="specs-row">
              <span className="label">Dustbin Capacity</span>
              <span className="value">350ml (robot) / 4L (base station)</span>
            </div>
            <div className="specs-row">
              <span className="label">Water Tank</span>
              <span className="value">
                80ml (robot) / 4.5L clean + 4L dirty (base station)
              </span>
            </div>
            <div className="specs-row">
              <span className="label">Noise Level</span>
              <span className="value">62-68 dB</span>
            </div>
            <div className="specs-row">
              <span className="label">Navigation</span>
              <span className="value">LiDAR + 3D structured light</span>
            </div>
            <div className="specs-row">
              <span className="label">Dimensions</span>
              <span className="value">350 × 350 × 104mm (robot)</span>
            </div>
            <div className="specs-row">
              <span className="label">Weight</span>
              <span className="value">4.9kg (robot)</span>
            </div>
            <div className="specs-row">
              <span className="label">Charging Time</span>
              <span className="value">Approximately 4 hours</span>
            </div>
            <div className="specs-row">
              <span className="label">Connectivity</span>
              <span className="value">Wi-Fi 2.4GHz/5GHz, Bluetooth</span>
            </div>
            <div className="specs-row">
              <span className="label">Compatibility</span>
              <span className="value">Alexa, Google Home, Dreame App</span>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
