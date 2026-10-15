import assert from "node:assert/strict";
import { test } from "bun:test";
import { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/types/zktls-self-host";
import { TAB_TRANSITION_DELAY_MS } from "../src/utils/constants/config.js";
import {
  MESSAGE_ACTIONS,
  MESSAGE_SOURCES,
  RECLAIM_SESSION_STATUS,
} from "../src/utils/constants/interfaces.js";
import { EVENT_TYPES } from "../src/utils/logger/constants.js";

const ID = "ending-one";
const CALLER_TAB = 42;
const PROVIDER_TAB = 85;
const profile = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const now = Math.floor(Date.now() / 1000);
const session = {
  sessionId: ID,
  route: {
    profile: profile.profile,
    callerOrigin: profile.callerOrigin,
    backendUrl: profile.backendUrl,
    attestorUrl: profile.attestorUrl,
    authority: {
      digest: `sha256:${"c".repeat(64)}`,
      validUntil: new Date((now + 600) * 1000).toISOString(),
    },
  },
  umia: {
    providerVersion: "v1",
    sessionToken: "a".repeat(64),
    expiresAt: new Date((now + 600) * 1000).toISOString(),
    attestorAuth: {
      data: {
        id: ID,
        createdAt: now - 1,
        expiresAt: now + 300,
        hostWhitelist: ["fixture.example"],
      },
      signature: `0x${"d".repeat(130)}`,
    },
  },
};
const binding = Object.freeze({
  sessionId: ID,
  tabId: CALLER_TAB,
  extensionId: "test-extension",
  documentId: "hub-document",
  profile: profile.profile,
});
const callerSender = {
  id: "test-extension",
  tab: { id: CALLER_TAB },
  frameId: 0,
  documentId: "hub-document",
  url: `${profile.callerOrigin}/auction/1`,
  origin: profile.callerOrigin,
};

let sent = [];
globalThis.window = globalThis.window || globalThis;
globalThis.chrome = {
  runtime: { id: "test-extension", sendMessage: async () => ({}) },
  tabs: {
    get: async () => ({ url: `${profile.callerOrigin}/auction/1` }),
    sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options });
      return {};
    },
    update: async () => {},
    remove: async () => {},
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
};
const {
  cancelSession,
  expireSession,
  failSession,
  handleTabRemoved,
  missingRequestCode,
  submitProofs,
} = await import("../src/background/sessionManager.js");
const { handleMessage } = await import("../src/background/messageRouter.js");

function context() {
  const ctx = {
    MESSAGE_ACTIONS,
    MESSAGE_SOURCES,
    RECLAIM_SESSION_STATUS,
    EVENT_TYPES,
    expectManyClaims: false,
    aborted: false,
    sessionId: ID,
    activeSessionId: ID,
    session,
    initiatingSender: binding,
    originalTabId: CALLER_TAB,
    activeTabId: PROVIDER_TAB,
    managedTabs: new Set([PROVIDER_TAB]),
    generatedProofs: new Map([["request-one", { claim: { identifier: "local" } }]]),
    providerRequestsByHash: new Map(),
    providerData: { requestData: [] },
    proofGenerationQueue: [],
    sessionTimerManager: { clearAllTimers() {}, clearExpiryTimer() {} },
    statuses: [],
    closed: [],
    submitResults: [],
    updateSessionStatus: async (_session, status, code) => {
      await Bun.sleep(5);
      ctx.statuses.push([status, code]);
    },
    closeBoundSession: async (id) => {
      ctx.closed.push(id);
    },
    formatProof: () => ({ claim: { identifier: "local" } }),
    submitBoundProofs: async () => {
      await Bun.sleep(5);
      const result = ctx.submitResults.shift();
      if (result instanceof Error) throw result;
      return [{ claim: { identifier: "accepted" } }];
    },
  };
  ctx.failSession = (...args) => failSession(ctx, ...args);
  return ctx;
}

test("an unmet response criterion ends the bound session and returns to the Hub", async () => {
  const ctx = context();
  ctx.providerData = { requestData: [{ requestHash: "request-one" }, { requestHash: "request-two" }] };
  ctx.responseMatchFailures = new Set();
  ctx.filteredRequests = new Map();
  ctx.firstRequestReceived = false;
  const timerOps = [];
  ctx.sessionTimerManager.startSessionTimer = () => timerOps.push("start");
  ctx.sessionTimerManager.clearSessionTimer = () => timerOps.push("clear");
  const providerSender = {
    id: "test-extension",
    tab: { id: PROVIDER_TAB },
    frameId: 0,
    documentId: "provider-document",
    documentLifecycle: "active",
  };
  const send = async (action, data, sender = providerSender) => {
    let response;
    await handleMessage(
      ctx,
      { action, source: MESSAGE_SOURCES.CONTENT_SCRIPT, target: MESSAGE_SOURCES.BACKGROUND, data },
      sender,
      (value) => (response = value),
    );
    return response;
  };
  assert.deepEqual(
    await send(
      MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT,
      { sessionId: ID, requestHash: "request-two", failed: true },
      { ...providerSender, tab: { id: 99 } },
    ),
    { success: false, error: "REQUEST_REJECTED" },
  );
  assert.deepEqual(
    await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
      sessionId: ID,
      requestHash: "other",
      failed: true,
    }),
    { success: false, error: "REQUEST_REJECTED" },
  );
  assert.equal(missingRequestCode(ctx), "REQUEST_NOT_CAPTURED");
  assert.deepEqual(timerOps, []);
  assert.equal(ctx.activeSessionId, ID);
  assert.deepEqual(
    await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
      sessionId: ID,
      requestHash: "request-two",
      failed: true,
    }),
    { success: true },
  );
  assert.equal(missingRequestCode(ctx), "CRITERIA_NOT_MET");
  assert.deepEqual(timerOps, ["start"]);
  await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
    sessionId: ID,
    requestHash: "request-two",
    failed: true,
  });
  assert.deepEqual(timerOps, ["start"], "a repeat does not extend the decision window");
  assert.deepEqual(
    await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
      sessionId: ID,
      requestHash: "request-two",
      failed: false,
    }),
    { success: true },
  );
  assert.equal(missingRequestCode(ctx), "REQUEST_NOT_CAPTURED");
  assert.deepEqual(timerOps, ["start", "clear"]);
  await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
    sessionId: ID,
    requestHash: "request-two",
    failed: true,
  });
  assert.deepEqual(timerOps, ["start", "clear", "start"]);
  ctx.generatedProofs.set("request-two", { claim: { identifier: "later-proof" } });
  assert.equal(missingRequestCode(ctx), "REQUEST_NOT_CAPTURED");
  ctx.generatedProofs.delete("request-two");

  const tabOps = [];
  const scheduled = [];
  const originalUpdate = chrome.tabs.update;
  const originalRemove = chrome.tabs.remove;
  const originalTimeout = globalThis.setTimeout;
  chrome.tabs.update = async (id, options) => tabOps.push(["update", id, options]);
  chrome.tabs.remove = async (id) => tabOps.push(["remove", id]);
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === TAB_TRANSITION_DELAY_MS) {
      scheduled.push(() => callback(...args));
      return 1;
    }
    return originalTimeout(callback, ms, ...args);
  };
  sent = [];
  try {
    assert.deepEqual(
      await send(
        MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT,
        { sessionId: ID, requestHash: "request-two", failed: true },
        {
          ...providerSender,
          frameId: 1,
          origin: "https://unapproved.example",
          url: "https://unapproved.example/",
        },
      ),
      { success: false, error: "REQUEST_REJECTED" },
    );
    assert.deepEqual(
      await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
        sessionId: "stale",
        requestHash: "request-two",
        failed: true,
      }),
      { success: false, error: "REQUEST_REJECTED" },
    );
    await ctx.failSession(missingRequestCode(ctx));
    assert.deepEqual(ctx.statuses, [
      [RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, "CRITERIA_NOT_MET"],
    ]);
    assert.equal(ctx.activeSessionId, null);
    assert.deepEqual(
      await send(MESSAGE_ACTIONS.RESPONSE_MATCH_RESULT, {
        sessionId: null,
        requestHash: "request-two",
        failed: true,
      }),
      { success: false, error: "REQUEST_REJECTED" },
    );
    assert.equal(
      sent.find(({ tabId }) => tabId === CALLER_TAB)?.message.data.error,
      "CRITERIA_NOT_MET",
    );
    assert.equal(
      sent.find(({ tabId }) => tabId === PROVIDER_TAB)?.message.data.error,
      "CRITERIA_NOT_MET",
    );
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    assert.deepEqual(tabOps, [
      ["update", CALLER_TAB, { active: true }],
      ["remove", PROVIDER_TAB],
    ]);
  } finally {
    chrome.tabs.update = originalUpdate;
    chrome.tabs.remove = originalRemove;
    globalThis.setTimeout = originalTimeout;
  }
});

// Every way a bound session can end. `code` is what the session reports when this trigger wins.
const TRIGGERS = {
  failure: { code: "REQUEST_NOT_CAPTURED", run: (ctx) => failSession(ctx, "REQUEST_NOT_CAPTURED") },
  cancel: { code: "CANCELLED", run: (ctx) => cancelSession(ctx, ID) },
  "tab close": { code: "TAB_CLOSED", run: (ctx) => handleTabRemoved(ctx, PROVIDER_TAB) },
  expiry: { code: "SESSION_EXPIRED", run: (ctx) => expireSession(ctx, ctx.session, ID) },
  "submit success": {
    success: true,
    run: (ctx) => {
      ctx.submitResults.push("accepted");
      return submitProofs(ctx);
    },
  },
  "submit failure": {
    code: "BACKEND_UNREACHABLE",
    submit: true,
    run: (ctx) => {
      ctx.submitResults.push(new Error("BACKEND_UNREACHABLE"));
      return submitProofs(ctx);
    },
  },
  "page teardown": {
    code: "CANCELLED",
    run: (ctx) =>
      handleMessage(
        ctx,
        {
          action: MESSAGE_ACTIONS.CANCEL_VERIFICATION,
          source: MESSAGE_SOURCES.CONTENT_SCRIPT,
          target: MESSAGE_SOURCES.BACKGROUND,
          data: { sessionId: ID },
        },
        callerSender,
        () => {},
      ),
  },
};

// The first trigger owns the end. A failing submission reports a trigger recorded meanwhile,
// which explains its failure better than the intake error; a successful one always wins.
function winner(first, second) {
  if (first.success) return { success: true };
  if (first.submit && second.code) return { code: second.code };
  return { code: first.code };
}

const TERMINAL_ACTIONS = new Set([
  MESSAGE_ACTIONS.PROOF_SUBMITTED,
  MESSAGE_ACTIONS.PROOF_GENERATION_FAILED,
  MESSAGE_ACTIONS.PROOF_SUBMISSION_FAILED,
]);

const pairs = Object.keys(TRIGGERS).flatMap((first) =>
  Object.keys(TRIGGERS)
    .filter((second) => second !== first)
    .map((second) => [first, second]),
);

test.each(pairs)("%s then %s ends the session exactly once", async (firstName, secondName) => {
  sent = [];
  const ctx = context();
  const first = TRIGGERS[firstName];
  const second = TRIGGERS[secondName];
  await Promise.allSettled([first.run(ctx), second.run(ctx)]);

  const expected = winner(first, second);
  const toCaller = sent.filter(
    ({ tabId, message, options }) =>
      tabId === CALLER_TAB && options?.frameId === 0 && TERMINAL_ACTIONS.has(message.action),
  );
  assert.equal(toCaller.length, 1, "the page Promise settles exactly once");
  const [terminal] = toCaller;
  assert.equal(terminal.options.documentId, "hub-document");
  if (expected.success) {
    assert.equal(terminal.message.action, MESSAGE_ACTIONS.PROOF_SUBMITTED);
    assert.deepEqual(ctx.statuses, []);
  } else {
    assert.notEqual(terminal.message.action, MESSAGE_ACTIONS.PROOF_SUBMITTED);
    assert.equal(terminal.message.data.error, expected.code);
    assert.deepEqual(ctx.statuses, [
      expected.code === "CANCELLED"
        ? [RECLAIM_SESSION_STATUS.SESSION_CANCELLED, undefined]
        : [RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED, expected.code],
    ]);
  }
  assert.deepEqual(ctx.closed, [ID], "teardown runs once");
  assert.equal(ctx.activeSessionId, null);
});

test("a tab closed while the session is ending leaves the guard to the owner until it delivers", async () => {
  sent = [];
  const ctx = context();
  let finishIntake;
  ctx.submitBoundProofs = () =>
    new Promise((resolve) => {
      finishIntake = () => resolve([{ claim: { identifier: "accepted" } }]);
    });
  const submission = submitProofs(ctx);
  await handleTabRemoved(ctx, PROVIDER_TAB);

  // Releasing these mid-delivery would let the router start another session over this teardown.
  assert.equal(ctx.activeSessionId, ID);
  assert.equal(ctx.initiatingSender, binding);
  assert.equal(ctx.originalTabId, CALLER_TAB);

  finishIntake();
  await submission;
  assert.deepEqual(
    sent
      .filter(({ tabId, message }) => tabId === CALLER_TAB && TERMINAL_ACTIONS.has(message.action))
      .map(({ message }) => message.action),
    [MESSAGE_ACTIONS.PROOF_SUBMITTED],
  );
  assert.equal(ctx.activeSessionId, null);
  assert.equal(ctx.initiatingSender, null);
});
