(function () {
  var scripts = document.getElementsByTagName("script");
  var currentScript = document.currentScript || scripts[scripts.length - 1];

  var productId = currentScript.getAttribute("data-product-id") || "";
  var mountSelector = currentScript.getAttribute("data-mount");
  var apiBaseAttr = currentScript.getAttribute("data-api-base");
  var clientId = currentScript.getAttribute("data-client-id") || "";
  var embedSecret = currentScript.getAttribute("data-embed-secret") || "";

  // Derive appBase from the script's own src attribute so retailers never
  // hard-code the deployment URL twice.
  var appBase = apiBaseAttr;
  if (!appBase && currentScript.src) {
    appBase = currentScript.src.replace(/\/embed\.js(\?.*)?$/, "");
  }
  if (!appBase) appBase = "";

  // Resolve the mount element. data-mount wins; otherwise insert the iframe
  // immediately after the script tag, which lands it where the tag was dropped.
  var mount = null;
  if (mountSelector) {
    mount = document.querySelector(mountSelector);
  }
  if (!mount) {
    mount = document.createElement("div");
    mount.setAttribute("data-product-insights-mount", "");
    if (currentScript.parentNode) {
      currentScript.parentNode.insertBefore(mount, currentScript.nextSibling);
    } else {
      document.body.appendChild(mount);
    }
  }

  var iframe = document.createElement("iframe");
  var iframeSrc =
    appBase +
    "/widget/host.html?productId=" +
    encodeURIComponent(productId || "");
  if (clientId) {
    iframeSrc += "&clientId=" + encodeURIComponent(clientId);
  }
  if (embedSecret) {
    iframeSrc += "&secret=" + encodeURIComponent(embedSecret);
  }
  iframe.src = iframeSrc;
  iframe.title = "Product Insights";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  iframe.style.width = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.height = "0px";
  mount.appendChild(iframe);

  var expectedOrigin = (function () {
    try {
      return new URL(appBase || window.location.href, window.location.href)
        .origin;
    } catch {
      return null;
    }
  })();

  window.addEventListener("message", function (event) {
    if (expectedOrigin && event.origin !== expectedOrigin) return;
    var data = event.data;
    if (!data || data.type !== "product-insights:resize") return;
    var h = Number(data.height);
    if (!isFinite(h) || h <= 0) return;
    iframe.style.height = h + "px";
  });
})();
