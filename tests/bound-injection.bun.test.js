import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { publicProviderData, runBoundInjection } from "../src/background/injectionManager.js";

const code = "window.Reclaim.updatePublicData({ok: true})";
const digest = `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;
const origin = "https://provider.example";
const documentId = "provider-document";

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sessionId: "bound-one",
    umia: {
      providerVersion: "v7",
      sessionToken: "private-bearer",
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      attestorAuth: { data: { id: "bound-one", expiresAt: now + 300 } },
    },
    route: {
      authority: { validUntil: new Date((now + 600) * 1000).toISOString() },
    },
  };
  const providerData = {
    id: "approved-provider",
    version: "v7",
    versionNumber: "v7",
    providerConfigs: [{ loginUrl: `${origin}/login` }],
    customInjection: code,
    customInjectionSha256: digest,
    recipeDigest: `sha256:${"a".repeat(64)}`,
  };
  const ctx = {
    session,
    providerData,
    providerLoginUrl: `${origin}/login`,
    providerId: "approved-provider",
    sessionId: "bound-one",
    activeSessionId: "bound-one",
    activeTabId: 91,
    managedTabs: new Set([91]),
    injectionOperations: new Map(),
    aborted: false,
  };
  const sender = {
    id: "installed-extension",
    tab: { id: 91 },
    frameId: 0,
    documentId,
    documentLifecycle: "active",
    origin,
    url: `${origin}/login`,
  };
  const calls = [];
  globalThis.chrome = {
    runtime: { id: "installed-extension" },
    tabs: { get: async () => ({ url: `${origin}/login` }) },
    scripting: {
      executeScript: async (injection) => {
        calls.push(injection);
        return [{ documentId, frameId: 0, result: { status: "executed" } }];
      },
    },
  };
  return { ctx, sender, calls };
}

const operation = { op: "RUN_CUSTOM_INJECTION" };

test("only approved code reaches one bound MAIN document", async () => {
  const { ctx, sender, calls } = fixture();
  assert.deepEqual(await runBoundInjection(ctx, sender, operation), {
    success: true,
    status: "executed",
  });
  assert.deepEqual(calls[0].target, { tabId: 91, documentIds: [documentId] });
  assert.equal(calls[0].world, "MAIN");
  assert.deepEqual(calls[0].args, [code]);
  assert.equal(JSON.stringify(calls[0]).includes(ctx.session.umia.sessionToken), false);
  assert.deepEqual(await runBoundInjection(ctx, sender, operation), {
    success: true,
    status: "duplicate",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(publicProviderData(ctx), {
    id: "approved-provider",
    version: "v7",
    versionNumber: "v7",
    providerConfigs: [{ loginUrl: `${origin}/login` }],
    recipeDigest: ctx.providerData.recipeDigest,
    loginUrl: `${origin}/login`,
  });
});

test("a rejected provider pin fails before a provider tab is opened", async () => {
  globalThis.window = globalThis.window || globalThis;
  const { startVerification } = await import("../src/background/sessionManager.js");
  const { ctx } = fixture();
  let opened = 0;
  chrome.tabs.create = () => (opened += 1);
  ctx.initiatingSender = { documentId: "caller-document" };
  ctx.sessionTimerManager = { clearAllTimers() {}, clearExpiryTimer() {}, startExpiryTimer() {} };
  ctx.fetchProviderData = async () => {
    throw new Error("Pinned provider metadata rejected");
  };
  await assert.rejects(
    startVerification(ctx, {
      sessionId: "bound-one",
      providerId: "approved-provider",
      session: {
        ...ctx.session,
        route: {
          ...ctx.session.route,
          authority: { ...ctx.session.route.authority, witnesses: [] },
          network: {},
        },
      },
    }),
    /Pinned provider metadata rejected/,
  );
  assert.equal(opened, 0);
  assert.equal(ctx.providerData, null);
  assert.equal(ctx.providerLoginUrl, null);
});

test("rejects page-supplied code, provider overrides, and wrong bound metadata", async () => {
  for (const supplied of [
    { op: "RUN_CUSTOM_INJECTION", code: "evil" },
    { op: "RUN_CUSTOM_INJECTION", providerId: "other" },
    { op: "REPLAY_PAGE_FETCH" },
  ]) {
    const { ctx, sender, calls } = fixture();
    assert.equal((await runBoundInjection(ctx, sender, supplied)).success, false);
    assert.equal(calls.length, 0);
  }
  for (const change of [
    (ctx) => (ctx.providerLoginUrl = "https://other.example/login"),
    (ctx) => (ctx.providerLoginUrl = null),
    (ctx) => (ctx.providerData.customInjectionSha256 = ctx.providerData.recipeDigest),
    (ctx) => (ctx.providerData.customInjectionSha256 = undefined),
    (ctx) => (ctx.providerData.customInjection += "\n"),
  ]) {
    const { ctx, sender, calls } = fixture();
    change(ctx);
    assert.equal((await runBoundInjection(ctx, sender, operation)).success, false);
    assert.equal(calls.length, 0);
  }
});

test("rejects unowned frames, documents, origins, expired and cancelled sessions", async () => {
  for (const change of [
    (_ctx, sender) => (sender.id = "other-extension"),
    (_ctx, sender) => (sender.tab.id = 92),
    (_ctx, sender) => (sender.frameId = 1),
    (_ctx, sender) => (sender.documentId = undefined),
    (_ctx, sender) => (sender.documentLifecycle = "prerender"),
    (_ctx, sender) => (sender.origin = "https://other.example"),
    (_ctx, sender) => (sender.url = "https://other.example/login"),
    (ctx) => ctx.managedTabs.clear(),
    (ctx) => (ctx.aborted = true),
    (ctx) => (ctx.session.umia.expiresAt = "2000-01-01T00:00:00.000Z"),
    (ctx) => (ctx.session.umia.attestorAuth.data.expiresAt = 1),
  ]) {
    const { ctx, sender, calls } = fixture();
    change(ctx, sender);
    assert.equal((await runBoundInjection(ctx, sender, operation)).success, false);
    assert.equal(calls.length, 0);
  }
  const { ctx, sender, calls } = fixture();
  chrome.tabs.get = async () => ({ url: "https://other.example" });
  assert.equal((await runBoundInjection(ctx, sender, operation)).success, false);
  assert.equal(calls.length, 0);
});

test("suppresses stale results after replacement and never reruns the old document", async () => {
  const { ctx, sender, calls } = fixture();
  let settle;
  let entered;
  const executing = new Promise((resolve) => (entered = resolve));
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    entered();
    return await new Promise((resolve) => (settle = resolve));
  };
  const pending = runBoundInjection(ctx, sender, operation);
  await executing;
  ctx.activeSessionId = "bound-two";
  ctx.injectionOperations = new Map();
  settle([{ documentId, frameId: 0, result: { status: "executed" } }]);
  assert.deepEqual(await pending, { success: false, error: "CANCELLED" });
  assert.equal(calls.length, 1);
});

test("runs once per navigated document and skips providers without code", async () => {
  const { ctx, sender, calls } = fixture();
  assert.equal((await runBoundInjection(ctx, sender, operation)).status, "executed");
  const navigated = { ...sender, documentId: "next-document" };
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    return [{ documentId: "next-document", frameId: 0, result: { status: "executed" } }];
  };
  assert.equal((await runBoundInjection(ctx, navigated, operation)).status, "executed");
  assert.deepEqual(calls[1].target, { tabId: 91, documentIds: ["next-document"] });

  const bare = fixture();
  delete bare.ctx.providerData.customInjection;
  delete bare.ctx.providerData.customInjectionSha256;
  assert.deepEqual(await runBoundInjection(bare.ctx, bare.sender, operation), {
    success: true,
    status: "skipped",
  });
  assert.equal(bare.calls.length, 0);
});

test("a failed or uncertain execution never reruns in the same document", async () => {
  for (const outcome of [
    async () => [{ documentId, frameId: 0, result: { status: "error" } }],
    async () => [{ documentId: "other-document", frameId: 0, result: { status: "executed" } }],
    async () => [],
    async () => {
      throw new Error("Frame with ID 0 was removed");
    },
  ]) {
    const { ctx, sender, calls } = fixture();
    chrome.scripting.executeScript = async (injection) => {
      calls.push(injection);
      return outcome();
    };
    assert.deepEqual(await runBoundInjection(ctx, sender, operation), {
      success: false,
      error: "INJECTION_REJECTED",
    });
    assert.deepEqual(await runBoundInjection(ctx, sender, operation), {
      success: false,
      error: "INJECTION_REJECTED",
    });
    assert.equal(calls.length, 1);
  }
});

test("a concurrent request for a pending document is rejected without a second run", async () => {
  const { ctx, sender, calls } = fixture();
  let settle;
  chrome.scripting.executeScript = async (injection) => {
    calls.push(injection);
    return await new Promise((resolve) => (settle = resolve));
  };
  const first = runBoundInjection(ctx, sender, operation);
  assert.deepEqual(await runBoundInjection(ctx, sender, operation), {
    success: false,
    error: "INJECTION_REJECTED",
  });
  while (!settle) await new Promise((resolve) => setTimeout(resolve, 0));
  settle([{ documentId, frameId: 0, result: { status: "executed" } }]);
  assert.equal((await first).status, "executed");
  assert.equal(calls.length, 1);
});

test("page-world and content sources carry no code, provider ID, or hosted loader", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const page = read("../src/interceptor/injection-scripts.js");
  for (const banned of ["fetch(", "eval", "reclaimprotocol", "InjectionScript", "ProviderId"]) {
    assert.equal(page.includes(banned), false, banned);
  }
  const content = read("../src/content/content.js");
  for (const banned of ["customInjection", "REPLAY_PAGE_FETCH", "RECLAIM_GET_PROVIDER_ID"]) {
    assert.equal(content.includes(banned), false, banned);
  }
});
