import { requireLiveSession } from "../utils/session-config";
import { normalizeUrlType, URL_TYPES } from "../utils/provider-normalization";
import { templateVariables } from "../utils/claim-creator/network-filter";

export const REPLAY_OP = "REPLAY_BOUND_DOCUMENT";
// Replays per session, so a page cycling its URL cannot turn replay into a request loop.
export const MAX_REPLAYS_PER_SESSION = 3;
const REPLAY_KEY = "replay|";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

// Content needs the provider's request rules, but executable code stays in the
// background with the authenticated, version-pinned registry response.
export function publicProviderData(ctx) {
  if (!ctx.providerData) return ctx.providerData;
  const { customInjection, customInjectionSha256, ...publicData } = ctx.providerData;
  return { ...publicData, loginUrl: ctx.providerLoginUrl };
}

function current(ctx, bound) {
  requireLiveSession(bound.session);
  return (
    !ctx.aborted &&
    ctx.session === bound.session &&
    ctx.providerData === bound.provider &&
    ctx.providerLoginUrl === bound.loginUrl &&
    ctx.activeSessionId === bound.sessionId &&
    ctx.sessionId === bound.sessionId &&
    ctx.activeTabId === bound.tabId &&
    ctx.managedTabs.has(bound.tabId) &&
    ctx.injectionOperations === bound.operations
  );
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin !== "null"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

async function injectionDigest(code) {
  const bytes = new TextEncoder().encode(code);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

// An operation request is never an input channel for code, a provider, a
// backend, a URL, or a token: it carries exactly one field, its op.
function isOperation(data, op) {
  return !!data && Object.keys(data).length === 1 && data.op === op;
}

// The live session's provider tab, top frame and active document, on the login origin;
// null otherwise, including when the session has expired.
function boundSender(ctx, sender) {
  try {
    return liveBoundSender(ctx, sender);
  } catch {
    return null;
  }
}

function liveBoundSender(ctx, sender) {
  const bound = {
    tabId: sender?.tab?.id,
    documentId: sender?.documentId,
    session: ctx.session,
    provider: ctx.providerData,
    loginUrl: ctx.providerLoginUrl,
    sessionId: ctx.activeSessionId,
    operations: ctx.injectionOperations,
  };
  if (
    sender?.id !== chrome.runtime.id ||
    sender?.frameId !== 0 ||
    (sender?.documentLifecycle && sender.documentLifecycle !== "active") ||
    typeof bound.documentId !== "string" ||
    !bound.documentId ||
    !Number.isInteger(bound.tabId) ||
    !(bound.operations instanceof Map) ||
    !bound.provider ||
    !current(ctx, bound)
  ) {
    return null;
  }
  const expectedOrigin = originOf(bound.loginUrl);
  if (
    !expectedOrigin ||
    sender.origin !== expectedOrigin ||
    originOf(sender.url) !== expectedOrigin
  ) {
    return null;
  }
  return { ...bound, expectedOrigin };
}

export async function runBoundInjection(ctx, sender, data) {
  if (!isOperation(data, "RUN_CUSTOM_INJECTION")) {
    return { success: false, error: "INJECTION_REJECTED" };
  }

  const bound = boundSender(ctx, sender);
  if (!bound) return { success: false, error: "INJECTION_REJECTED" };
  const { tabId, documentId, provider, operations, expectedOrigin } = bound;

  try {
    const code = provider.customInjection;
    const digest = provider.customInjectionSha256;
    if ((code === undefined || code === null || code === "") && !digest) {
      return { success: true, status: "skipped" };
    }
    if (typeof code !== "string" || !code || !SHA256.test(digest || "")) {
      return { success: false, error: "INJECTION_REJECTED" };
    }

    if (operations.has(documentId)) {
      return operations.get(documentId) === "executed"
        ? { success: true, status: "duplicate" }
        : { success: false, error: "INJECTION_REJECTED" };
    }
    // Reserve before the first await. An uncertain executeScript outcome must
    // never re-run provider code in the same session/document.
    operations.set(documentId, "pending");

    if ((await injectionDigest(code)) !== digest || !current(ctx, bound)) {
      operations.set(documentId, "rejected");
      return { success: false, error: "INJECTION_REJECTED" };
    }

    const tab = await chrome.tabs.get(tabId);
    if (originOf(tab?.url) !== expectedOrigin || !current(ctx, bound)) {
      operations.set(documentId, "rejected");
      return { success: false, error: "INJECTION_REJECTED" };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: "MAIN",
      func: (approvedCode) => {
        try {
          (0, eval)(approvedCode);
          return { status: "executed" };
        } catch {
          // Page exception text may include private page data.
          return { status: "error" };
        }
      },
      args: [code],
    });

    if (!current(ctx, bound)) {
      operations.set(documentId, "rejected");
      return { success: false, error: "CANCELLED" };
    }
    const result = results?.[0];
    if (
      results?.length !== 1 ||
      result.documentId !== documentId ||
      result.frameId !== 0 ||
      result.result?.status !== "executed"
    ) {
      operations.set(documentId, "rejected");
      return { success: false, error: "INJECTION_REJECTED" };
    }
    operations.set(documentId, "executed");
    return { success: true, status: "executed" };
  } catch {
    if (operations.get(documentId) === "pending") operations.set(documentId, "rejected");
    return { success: false, error: "INJECTION_REJECTED" };
  }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path variable stays inside one path segment, a query variable inside one value.
function templatePattern(template) {
  const queryStart = template.indexOf("?");
  let pattern = "";
  let literalStart = 0;
  for (const match of template.matchAll(templateVariables())) {
    const inQuery = queryStart !== -1 && match.index > queryStart;
    pattern += escapeRegex(template.slice(literalStart, match.index));
    pattern += inQuery ? "[^&=#]+" : "[^/?#]+";
    literalStart = match.index + match[0].length;
  }
  return pattern + escapeRegex(template.slice(literalStart));
}

// The whole URL must match, so the query has exactly the declared parameters, in order.
function declaresUrl(request, url) {
  if (typeof request?.url !== "string" || !request.url) return false;
  const type = normalizeUrlType(request.urlType, request.url);
  if (type === URL_TYPES.CONSTANT) return request.url === url;
  const pattern = type === URL_TYPES.TEMPLATE ? templatePattern(request.url) : request.url;
  try {
    return new RegExp(`^(?:${pattern})$`, "s").test(url);
  } catch {
    return false;
  }
}

// A replay re-issues only a document request the pinned recipe declares as a plain GET.
function replayableUrl(provider, url) {
  return (
    Array.isArray(provider.requestData) &&
    provider.requestData.some(
      (request) =>
        String(request?.method).toUpperCase() === "GET" &&
        !request.bodySniff?.enabled &&
        declaresUrl(request, url),
    )
  );
}

/**
 * Re-requests the bound provider tab's own document as a credentialed same-origin XHR,
 * which the page-world interceptor captures like any page request. The URL comes from
 * the browser's tab record, never from the message.
 */
export async function runBoundReplay(ctx, sender, data) {
  if (!isOperation(data, REPLAY_OP)) return { success: false, error: "REPLAY_REJECTED" };

  const bound = boundSender(ctx, sender);
  if (!bound) return { success: false, error: "REPLAY_REJECTED" };
  const { tabId, documentId, session, provider, operations } = bound;

  let key;
  try {
    // Upstream's default: only an explicit opt-out disables replay.
    if (provider.disableRequestReplay === true) {
      return { success: true, status: "disabled" };
    }
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    const host = new URL(url).hostname;
    const hostWhitelist = session?.umia?.attestorAuth?.data?.hostWhitelist;
    if (
      !current(ctx, bound) ||
      url !== sender.url ||
      !Array.isArray(hostWhitelist) ||
      !hostWhitelist.includes(host) ||
      !replayableUrl(provider, url)
    ) {
      return { success: false, error: "REPLAY_REJECTED" };
    }

    key = `${REPLAY_KEY}${documentId}|${url}`;
    if (operations.has(key)) {
      return operations.get(key) === "executed"
        ? { success: true, status: "duplicate" }
        : { success: false, error: "REPLAY_REJECTED" };
    }
    const replays = [...operations.keys()].filter((k) => k.startsWith(REPLAY_KEY)).length;
    if (replays >= MAX_REPLAYS_PER_SESSION) return { success: false, error: "REPLAY_REJECTED" };
    // Reserve before the next await: an uncertain outcome must never send the request twice.
    operations.set(key, "pending");

    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      world: "MAIN",
      func: (approvedUrl) => {
        if (window.location.href !== approvedUrl) return { status: "moved" };
        if (!window.reclaimInterceptor) return { status: "not-ready" };
        try {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", approvedUrl, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader(
            "accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          );
          xhr.setRequestHeader("accept-language", "en-GB,en;q=0.5");
          xhr.setRequestHeader("cache-control", "no-store");
          xhr.send(null);
          return { status: "sent" };
        } catch {
          return { status: "error" };
        }
      },
      args: [url],
    });

    const result = results?.[0];
    const status =
      results?.length === 1 && result.documentId === documentId && result.frameId === 0
        ? result.result?.status
        : undefined;
    // Nothing was sent, so a later trigger may try this document and URL again.
    if (status === "moved" || status === "not-ready") {
      operations.delete(key);
      return { success: false, status };
    }
    if (status !== "sent") {
      operations.set(key, "rejected");
      return { success: false, error: "REPLAY_REJECTED" };
    }
    operations.set(key, "executed");
    return current(ctx, bound)
      ? { success: true, status: "executed" }
      : { success: false, error: "CANCELLED" };
  } catch {
    if (key && operations.get(key) === "pending") operations.set(key, "rejected");
    return { success: false, error: "REPLAY_REJECTED" };
  }
}
