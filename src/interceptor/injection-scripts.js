import { createPageLogger } from "./log-bridge";

// The window.Reclaim surface is installed at module scope, before the IIFE
// below builds its own logger, so it needs one of its own.
const apiLogger = createPageLogger("injection", "injection.api");

window.Reclaim = window.Reclaim || {};
let __reclaimParams = {};

try {
  const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
  if (ls) __reclaimParams = JSON.parse(ls) || {};
} catch {}

Object.defineProperty(window.Reclaim, "parameters", {
  get: () => {
    if (Object.keys(__reclaimParams).length > 0) return { ...__reclaimParams };
    try {
      const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
      return ls ? JSON.parse(ls) : {};
    } catch {
      return {};
    }
  },
  set: () => {},
  enumerable: true,
  configurable: false,
});

window.Reclaim.updatePublicData = function (obj) {
  try {
    const publicData = JSON.stringify(obj ?? {});
    window.postMessage(
      {
        action: "RECLAIM_SET_PUBLIC_DATA",
        data: { publicData },
      },
      "*",
    );
  } catch (e) {
    apiLogger.error("Reclaim.updatePublicData error:", e);
  }
};

window.Reclaim.canExpectManyClaims = function (flag) {
  try {
    window.postMessage(
      { action: "RECLAIM_SET_EXPECT_MANY_CLAIMS", data: { expectMany: !!flag } },
      "*",
    );
  } catch {}
};

window.Reclaim.reportProviderError = function (msg) {
  try {
    window.postMessage(
      {
        action: "RECLAIM_REPORT_PROVIDER_ERROR",
        data: { message: String(msg || "Provider error") },
      },
      "*",
    );
  } catch (e) {
    apiLogger.error("Reclaim.reportProviderError error:", e);
  }
};

window.Reclaim.requestClaim = function (rdObject) {
  try {
    // Was a bare console.log of the whole rdObject. That is a provider-authored
    // request descriptor which routinely carries the response the claim is
    // being built from, printed into the *provider tab's* console — the one
    // place the user can read it — with no config gate. Through the bridge it
    // obeys logLevel and gets redacted at INFO.
    apiLogger.info("Reclaim.requestClaim", { rdObject });
    window.postMessage({ action: "RECLAIM_REQUEST_CLAIM", data: { rdObject } }, "*");
  } catch (e) {
    apiLogger.error("Reclaim.requestClaim error:", e);
  }
};

window.Reclaim.getParametersSync = function () {
  try {
    const ls = localStorage.getItem("reclaimBrowserExtensionParameters");
    return ls ? JSON.parse(ls) : {};
  } catch {
    return {};
  }
};

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const { action, data } = e.data || {};
  if (action === "RECLAIM_PARAMETERS_CLEAR") {
    __reclaimParams = {};
    try {
      localStorage.removeItem("reclaimBrowserExtensionParameters");
    } catch {}
    return;
  }
  if (action === "RECLAIM_PARAMETERS_UPDATE" && data?.parameters) {
    const p = data.parameters || {};
    if (Object.keys(p).length === 0 && Object.keys(__reclaimParams).length > 0) return;
    __reclaimParams = p;
    try {
      localStorage.setItem("reclaimBrowserExtensionParameters", JSON.stringify(__reclaimParams));
    } catch {}
  }
});

try {
  window.postMessage({ action: "RECLAIM_PARAMETERS_GET" }, "*");
} catch {}
