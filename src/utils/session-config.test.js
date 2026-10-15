import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZKTLS_EXTENSION_ORIGIN_ALLOWLIST } from "@umia/types/zktls-self-host";
import {
  authorizeStart,
  boundSessionDeadline,
  approvedBackendUrl,
  requireLiveSession,
  validateCaller,
  validateSessionConfig,
} from "./session-config.js";
import {
  copyUmia,
  freezeBoundSession,
  takeOffscreenSession,
  verificationTemplate,
} from "./session-transport.js";
import { fetchProviderData, postTelemetry, updateSessionStatus } from "./fetch-calls.js";
import { formatProof } from "./proof-generator/proof-formatter.js";
import { failureCode } from "./constants/interfaces.js";

const approved = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST[0];
const profiles = [approved];
const sender = {
  url: `${approved.callerOrigin}/auction/1`,
  origin: approved.callerOrigin,
  tab: { id: 42 },
  frameId: 0,
};
const witness = `0x${"a".repeat(40)}`;
const selectedNetwork = {
  environment: "devnet",
  chainId: 10143,
  beaconAddress: `0x${"b".repeat(40)}`,
  expectedEpoch: 2,
  authorityDigest: `sha256:${"c".repeat(64)}`,
  witness,
  attestorUrl: approved.attestorUrl,
};

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionId: "session-one",
    providerId: "provider-one",
    providerVersion: "v7",
    resolvedProviderVersion: "v7",
    applicationId: "app-one",
    signature: "public-signature",
    timestamp: String(Date.now()),
    parameters: {},
    umia: {
      backendUrl: approved.backendUrl,
      attestorUrl: approved.attestorUrl,
      witness,
      providerVersion: "v7",
      sessionToken: "a".repeat(64),
      attestorAuth: {
        data: {
          id: "session-one",
          createdAt: now,
          expiresAt: now + 300,
          hostWhitelist: ["fixture.example"],
        },
        signature: `0x${"d".repeat(130)}`,
      },
      expiresAt: new Date((now + 600) * 1000).toISOString(),
      network: {
        environment: selectedNetwork.environment,
        chainId: selectedNetwork.chainId,
        beaconAddress: selectedNetwork.beaconAddress,
        expectedEpoch: selectedNetwork.expectedEpoch,
        authorityDigest: selectedNetwork.authorityDigest,
      },
    },
  };
}

function validate(request = fixture(), from = sender, chosen = selectedNetwork) {
  return validateSessionConfig(request, from, approved.profile, chosen, profiles);
}

function authority(profile, network) {
  return {
    environment: network.environment,
    chainId: network.chainId,
    beaconAddress: network.beaconAddress,
    epoch: network.expectedEpoch,
    attestorUrl: profile.attestorUrl,
    witnesses: [witness],
    minimumWitnesses: 1,
    sourceBlockNumber: "1",
    sourceBlockHash: `0x${"e".repeat(64)}`,
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
    digest: network.authorityDigest,
  };
}

function route(profile = approved, network = selectedNetwork) {
  return {
    profile: profile.profile,
    callerOrigin: profile.callerOrigin,
    backendUrl: profile.backendUrl,
    attestorUrl: profile.attestorUrl,
    witness,
    network: {
      environment: network.environment,
      chainId: network.chainId,
      beaconAddress: network.beaconAddress,
      expectedEpoch: network.expectedEpoch,
      authorityDigest: network.authorityDigest,
    },
    authority: authority(profile, network),
  };
}

const CREDENTIAL_KEYS = ["providerVersion", "sessionToken", "attestorAuth", "expiresAt"];

function bound({ sessionId = "session-one", umia = fixture().umia, sessionRoute = route() } = {}) {
  return freezeBoundSession({ sessionId, umia, route: sessionRoute });
}

describe("bound SDK session routing", () => {
  it("keeps the canonical nested block through config copy, template, Chrome JSON and background copy", () => {
    const request = fixture();
    const fromConfig = { ...request, umia: copyUmia(request.umia) };
    const template = verificationTemplate(fromConfig);
    const chromeMessage = JSON.parse(
      JSON.stringify({ action: "START_VERIFICATION", data: template }),
    );
    const backgroundCopy = copyUmia(validate(chromeMessage.data));
    const offscreenMessage = JSON.parse(
      JSON.stringify({
        session: bound({ sessionId: template.sessionId, umia: backgroundCopy }),
        client: { url: backgroundCopy.attestorUrl },
      }),
    );
    const offscreen = takeOffscreenSession({
      ...offscreenMessage,
      client: {
        ...offscreenMessage.client,
        authRequest: { data: { hostWhitelist: ["attacker.example"] } },
      },
    });
    assert.deepEqual(Object.keys(offscreen.session.umia), CREDENTIAL_KEYS);
    for (const key of CREDENTIAL_KEYS) {
      assert.deepEqual(offscreen.session.umia[key], request.umia[key]);
    }
    assert.equal(offscreen.session.sessionId, request.sessionId);
    assert.equal(offscreen.session.route.backendUrl, request.umia.backendUrl);
    assert.equal(offscreen.claim.session, undefined);
    assert.equal(JSON.stringify(offscreen.claim).includes(request.umia.sessionToken), false);
    assert.equal(offscreen.claim.client.url, request.umia.attestorUrl);
    assert.equal(offscreen.claim.client.authRequest, undefined);
    assert.notEqual(fromConfig.umia, request.umia);
    assert.notEqual(template.umia, fromConfig.umia);
    assert.notEqual(backgroundCopy, chromeMessage.data.umia);
    assert.throws(
      () =>
        takeOffscreenSession({
          ...offscreenMessage,
          client: { url: "wss://attestor.zktls.umia.finance.evil/ws" },
        }),
      /Offscreen attestor destination mismatch/,
    );
  });

  it("rejects absent, malformed and mismatched bound credentials and pin", () => {
    for (const change of [
      (r) => delete r.umia,
      (r) => {
        r.umia.sessionToken = "";
      },
      (r) => {
        r.umia.sessionToken = "A".repeat(64);
      },
      (r) => {
        r.umia.sessionToken = "x".repeat(64);
      },
      (r) => {
        r.umia.attestorAuth.signature = "0x12";
      },
      (r) => {
        r.umia.attestorAuth.data.id = "other";
      },
      (r) => {
        r.umia.attestorAuth.data.hostWhitelist = [];
      },
      (r) => {
        r.umia.expiresAt = "2000-01-01T00:00:00.000Z";
      },
      (r) => {
        r.umia.providerVersion = "latest";
      },
      (r) => {
        r.umia.providerVersion = "latest";
        r.providerVersion = "latest";
        r.resolvedProviderVersion = "latest";
      },
      (r) => {
        r.resolvedProviderVersion = "v8";
      },
      (r) => {
        r.umia.sessionId = "other";
      },
    ]) {
      const request = fixture();
      change(request);
      assert.throws(() => validate(request));
    }
  });

  it("accepts a scoped attestor authorization only for its exact session", () => {
    const request = fixture();
    request.umia.attestorAuth.data.id = `umia1:${request.sessionId}:github:0x${"a".repeat(64)}:${"b".repeat(64)}`;
    assert.equal(validate(request).attestorAuth.data.id, request.umia.attestorAuth.data.id);
    request.umia.attestorAuth.data.id = `umia1:other:github:0x${"a".repeat(64)}:${"b".repeat(64)}`;
    assert.throws(() => validate(request), /Invalid attestor authorization/);
  });

  it("accepts only the signed canonical ASCII host wire form", () => {
    const canonical = fixture();
    canonical.umia.attestorAuth.data.hostWhitelist = ["api.example", "xn--bcher-kva.example"];
    assert.deepEqual(
      validate(canonical).attestorAuth.data.hostWhitelist,
      canonical.umia.attestorAuth.data.hostWhitelist,
    );
    for (const host of [
      "API.example",
      " api.example",
      "api.example ",
      "api_example",
      "api..example",
      "-api.example",
      "api-.example",
      "api.example.",
      "singlelabel",
      "api.localhost",
      "api.local",
      "api.internal",
      "127.0.0.1",
      "0x7f.1",
      `${"a".repeat(64)}.example`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example`,
      "bücher.example",
    ]) {
      const request = fixture();
      request.umia.attestorAuth.data.hostWhitelist = [host];
      assert.throws(() => validate(request), /Invalid attestor authorization/, host);
    }
  });

  it("accepts only the explicitly activated exact caller/backend/attestor profile", () => {
    assert.deepEqual(validate(), fixture().umia);
    assert.equal(validateCaller(sender, approved.profile).profile, approved.profile);
    for (const url of [
      "https://admin.umia.conductor:8443/auction/1",
      "https://hub.umia.conductor/auction/1",
      "https://hub.umia.conductor.evil:8443/auction/1",
      "https://hub.umia.conductor:8444/auction/1",
      "http://hub.umia.conductor:8443/auction/1",
      "https://user@hub.umia.conductor:8443/auction/1",
      "https://hub.umia.conductor:8443/%2e%2e/auction/1",
      "https://hub.umia.conductor:8443/auction/1?token=x",
      "https://hub.umia.conductor:8443/auction/1#part",
    ])
      assert.throws(() => validate(fixture(), { url, permissionsGranted: true }));
    for (const backendUrl of [
      "https://api.umia.conductor/zktls",
      "https://api.umia.conductor:8443/zktls-evil",
      "https://api.umia.conductor:8443/zktls/",
      "https://admin.umia.conductor:8443/zktls",
      "https://api.umia.conductor:8443/zktls/../zktls",
      "https://api.umia.conductor:8443/zktls?token=x",
      "https://api.umia.conductor:8443/zktls#x",
      "https://user@api.umia.conductor:8443/zktls",
    ]) {
      const request = fixture();
      request.umia.backendUrl = backendUrl;
      assert.throws(() => validate(request));
    }
    for (const attestorUrl of [
      `${approved.attestorUrl}-evil`,
      approved.attestorUrl.replace("/ws", "/ws-evil"),
      approved.attestorUrl.replace("/ws", ":444/ws"),
      approved.attestorUrl.replace("wss:", "ws:"),
      approved.attestorUrl.replace("/ws", "/%2e%2e/ws"),
    ]) {
      const request = fixture();
      request.umia.attestorUrl = attestorUrl;
      assert.throws(() => validate(request));
    }
  });

  it("normalizes only the effective default HTTPS port", () => {
    assert.equal(
      validateCaller({ url: "https://hub.umia.localhost:443/auction/1" }, "native-devnet")
        .callerOrigin,
      "https://hub.umia.localhost",
    );
    assert.equal(
      approvedBackendUrl("https://api.umia.localhost:443/zktls"),
      "https://api.umia.localhost/zktls",
    );
    assert.throws(
      () => approvedBackendUrl("https://api.umia.localhost:444/zktls"),
      /Unapproved backend/,
    );
  });

  it("accepts devnet Monad 10143 and rejects Base 84532 and mismatched authority", () => {
    assert.equal(validate().network.chainId, 10143);
    const base = fixture();
    base.umia.network.chainId = 84532;
    assert.throws(
      () => validate(base, sender, { ...selectedNetwork, chainId: 84532 }),
      /UNSUPPORTED_NETWORK/,
    );
    for (const field of ["beaconAddress", "expectedEpoch", "authorityDigest"]) {
      const request = fixture();
      request.umia.network[field] = field === "expectedEpoch" ? 3 : "wrong";
      assert.throws(() => validate(request), /authority mismatch/);
    }
    const wrongEnvironment = fixture();
    wrongEnvironment.umia.network.environment = "testnet";
    assert.throws(() => validate(wrongEnvironment), /authority mismatch/);
  });

  it("resolves each session in extension context without accepting page route overrides", async () => {
    const testnetProfile = ZKTLS_EXTENSION_ORIGIN_ALLOWLIST.find(
      (p) => p.profile === "cloud-testnet",
    );
    const activeProfiles = [approved, testnetProfile];
    const testnetNetwork = {
      ...selectedNetwork,
      environment: "testnet",
      chainId: 8453,
      attestorUrl: testnetProfile.attestorUrl,
    };
    const routes = new Map([
      [
        "session-one",
        { profile: approved.profile, authority: authority(approved, selectedNetwork) },
      ],
      [
        "session-two",
        { profile: testnetProfile.profile, authority: authority(testnetProfile, testnetNetwork) },
      ],
    ]);
    const received = [];
    const resolver = async (metadata) => {
      received.push(metadata);
      return routes.get(metadata.sessionId) || null;
    };
    const first = fixture();
    const firstBound = await authorizeStart(resolver, first, sender, activeProfiles);
    assert.equal(firstBound.sessionId, "session-one");
    assert.deepEqual(Object.keys(firstBound.umia), CREDENTIAL_KEYS);
    assert.equal(firstBound.route.backendUrl, approved.backendUrl);
    assert.equal(firstBound.route.witness, witness);
    assert.equal(Object.isFrozen(firstBound.umia.attestorAuth.data.hostWhitelist), true);
    assert.equal(Object.isFrozen(firstBound.route.authority.witnesses), true);
    const second = fixture();
    second.sessionId = "session-two";
    second.umia.network.environment = "testnet";
    second.umia.network.chainId = 8453;
    second.umia.attestorUrl = testnetProfile.attestorUrl;
    second.umia.attestorAuth.data.id = "session-two";
    const secondBound = await authorizeStart(resolver, second, sender, activeProfiles);
    assert.equal(secondBound.route.attestorUrl, testnetProfile.attestorUrl);
    assert.equal(firstBound.route.authority.attestorUrl, approved.attestorUrl);
    assert.equal(firstBound.route.attestorUrl, approved.attestorUrl);
    assert.deepEqual(
      received.map((m) => Object.keys(m)),
      [
        ["sender", "sessionId", "candidate"],
        ["sender", "sessionId", "candidate"],
      ],
    );
    assert.equal(received[0].sender, sender);
    assert.deepEqual(Object.keys(received[0].candidate), [
      "backendUrl",
      "attestorUrl",
      "witness",
      "network",
    ]);
    assert.equal(JSON.stringify(received[0].candidate).includes(first.umia.sessionToken), false);
    assert.equal(JSON.stringify(received[0].candidate).includes("attestorAuth"), false);
    second.umia.backendUrl = "https://api.umia.conductor:8443/zktls-evil";
    await assert.rejects(authorizeStart(resolver, second, sender, activeProfiles));
    second.umia.backendUrl = testnetProfile.backendUrl;
    second.umia.network.chainId = 10143;
    await assert.rejects(authorizeStart(resolver, second, sender, activeProfiles));
    routes.get("session-one").authority.validUntil = "2000-01-01T00:00:00.000Z";
    await assert.rejects(
      authorizeStart(resolver, first, sender, activeProfiles),
      /authority mismatch/,
    );
    routes.get("session-one").authority = authority(approved, selectedNetwork);
    routes.get("session-one").authority.witnesses[0] = `0x${"f".repeat(40)}`;
    assert.equal(firstBound.route.authority.witnesses[0], witness);
    await assert.rejects(
      authorizeStart(resolver, first, sender, activeProfiles),
      /authority mismatch/,
    );
    routes.get("session-one").authority = authority(approved, selectedNetwork);
    assert.equal(
      (await authorizeStart(resolver, first, sender, activeProfiles)).route.witness,
      witness,
    );
    routes.delete("session-one");
    await assert.rejects(
      authorizeStart(resolver, first, sender, activeProfiles),
      /not provisioned/,
    );
    routes.set("session-one", {
      profile: approved.profile,
      authority: authority(approved, selectedNetwork),
    });
    const resolverCalls = received.length;
    await assert.rejects(
      authorizeStart(
        resolver,
        first,
        {
          ...sender,
          url: "https://admin.umia.conductor:8443/auction/1",
          origin: "https://admin.umia.conductor:8443",
          permissionsGranted: true,
        },
        activeProfiles,
      ),
      /Caller is not approved/,
    );
    assert.equal(received.length, resolverCalls);
    await assert.rejects(
      authorizeStart(null, first, sender, activeProfiles),
      /resolver is required/,
    );
    await assert.rejects(
      authorizeStart(resolver, first, { ...sender, frameId: 1 }, activeProfiles),
      /top frame/,
    );
    await assert.rejects(
      authorizeStart(resolver, first, { ...sender, tab: undefined }, activeProfiles),
      /top frame/,
    );
    const originalChrome = globalThis.chrome;
    globalThis.chrome = { runtime: { id: "approved-extension" } };
    try {
      await assert.rejects(
        authorizeStart(resolver, first, { ...sender, id: "other-extension" }, activeProfiles),
        /Wrong extension sender/,
      );
      await authorizeStart(
        resolver,
        first,
        { ...sender, id: "approved-extension" },
        activeProfiles,
      );
    } finally {
      globalThis.chrome = originalChrome;
    }
  });

  it("rejects at start a signed auth that outlives its authority or predates the epoch", async () => {
    const request = fixture();
    const shortAuthority = authority(approved, selectedNetwork);
    shortAuthority.validUntil = new Date(
      (request.umia.attestorAuth.data.expiresAt - 60) * 1000,
    ).toISOString();
    const resolver = async () => ({ profile: approved.profile, authority: shortAuthority });
    await assert.rejects(
      authorizeStart(resolver, request, sender, profiles),
      /Invalid attestor authorization/,
    );
    const negative = fixture();
    negative.umia.attestorAuth.data.createdAt = -1;
    assert.throws(() => validate(negative), /Invalid attestor authorization/);
  });
});

function pinnedProvider() {
  return {
    id: "provider-one",
    version: "v7",
    versionNumber: "v7",
    recipeDigest: `sha256:${"a".repeat(64)}`,
    providerConfigs: [{ loginUrl: "https://provider.example/login" }],
  };
}

describe("backend and consumer transport", () => {
  it("returns the single versioned login URL with the pinned provider", async () => {
    const original = globalThis.fetch;
    let served;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: served }) });
    try {
      served = pinnedProvider();
      assert.deepEqual(await fetchProviderData("provider-one", bound()), {
        provider: served,
        loginUrl: "https://provider.example/login",
      });
      for (const change of [
        (p) => (p.id = "other-provider"),
        (p) => (p.version = "v8"),
        (p) => (p.recipeDigest = "invalid"),
        (p) => delete p.recipeDigest,
        (p) => (p.loginUrl = "https://provider.example/login"),
        (p) => (p.loginUrl = "https://other.example/login"),
      ]) {
        served = pinnedProvider();
        change(served);
        await assert.rejects(fetchProviderData("provider-one", bound()), /metadata rejected/);
      }
      for (const configs of [
        undefined,
        [],
        [
          { loginUrl: "https://provider.example/login" },
          { loginUrl: "https://provider.example/login" },
        ],
        [{}],
        [{ loginUrl: "" }],
        [{ loginUrl: "/login" }],
        [{ loginUrl: "http://provider.example/login" }],
        [{ loginUrl: "https://user@provider.example/login" }],
        [{ loginUrl: "https:provider.example/login" }],
        [{ loginUrl: "data:text/html,unsafe" }],
        [{ loginUrl: " https://provider.example/login" }],
        [{ loginUrl: "https://provider.example/login " }],
        [{ loginUrl: "https://provider.example\\@other.example/login" }],
      ]) {
        served = { ...pinnedProvider(), providerConfigs: configs };
        await assert.rejects(fetchProviderData("provider-one", bound()), /login URL unavailable/);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects missing and mismatched provider response pins", async () => {
    const original = globalThis.fetch;
    try {
      for (const versionNumber of [undefined, null, "latest", "v8", 7]) {
        globalThis.fetch = async () => ({
          ok: true,
          json: async () => ({ providers: { versionNumber } }),
        });
        await assert.rejects(
          fetchProviderData("provider-one", bound()),
          /does not match session pin/,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends bearer only to pinned provider and status endpoints", async () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () =>
          url.endsWith("/api/sdk/update/session/")
            ? { status: "success" }
            : { providers: pinnedProvider() },
        text: async () => "ok",
      };
    };
    try {
      const { umia } = fixture();
      const session = bound({ umia });
      await fetchProviderData("provider-one", session);
      await updateSessionStatus(session, "PROOF_GENERATION_STARTED");
      assert.equal(
        calls[0].url,
        `${approved.backendUrl}/api/providers/provider-one?versionNumber=v7`,
      );
      assert.equal(calls[1].url, `${approved.backendUrl}/api/sdk/update/session/`);
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.equal(calls[1].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(calls[1].options.redirect, "error");
      assert.deepEqual(JSON.parse(calls[1].options.body), {
        sessionId: "session-one",
        status: "PROOF_GENERATION_STARTED",
      });
      assert.equal(calls.length, 2);
      const forged = bound({
        sessionRoute: { ...route(), backendUrl: "https://api.umia.conductor.evil:8443/zktls" },
      });
      await assert.rejects(
        fetchProviderData("provider-one", forged),
        /Unapproved backend destination/,
      );
      assert.equal(calls.length, 2);
      await assert.rejects(
        fetchProviderData("provider-one", bound({ umia: { ...umia, providerVersion: "latest" } })),
        /Exact provider version/,
      );
      await assert.rejects(fetchProviderData("..", session), /Invalid backend path segment/);
      await assert.rejects(
        fetchProviderData("provider-one", bound({ sessionId: "other-session" })),
        /Bound session route mismatch/,
      );
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("posts telemetry only to the bound session route with its bearer", async () => {
    const original = globalThis.fetch;
    const calls = [];
    let status = 202;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: status < 300, status };
    };
    try {
      const { umia } = fixture();
      const events = [{ type: "page_ready", data: { stage: "page", clientEnv: "extension" } }];
      await postTelemetry(bound({ umia }), events);
      assert.equal(calls[0].url, `${approved.backendUrl}/api/sdk/telemetry`);
      assert.equal(calls[0].options.method, "POST");
      assert.equal(calls[0].options.redirect, "error");
      assert.equal(calls[0].options.headers.Authorization, `Bearer ${umia.sessionToken}`);
      assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: "session-one", events });
      status = 200;
      await assert.rejects(postTelemetry(bound({ umia }), events), /Telemetry rejected/);
      await assert.rejects(
        postTelemetry(bound({ sessionId: "other-session" }), events),
        /Bound session route mismatch/,
      );
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects dynamic or malformed geo at fetch time, before any tab opens", async () => {
    const original = globalThis.fetch;
    let served;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: served }) });
    try {
      served = { ...pinnedProvider(), geoLocation: "US" };
      assert.equal((await fetchProviderData("provider-one", bound())).provider.geoLocation, "US");
      for (const geoLocation of ["{{DYNAMIC_GEO}}", "USA", 1]) {
        served = { ...pinnedProvider(), geoLocation };
        await assert.rejects(fetchProviderData("provider-one", bound()), /CONFIG_REJECTED/);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports an unreachable backend and an expired session by their own codes", async () => {
    const original = globalThis.fetch;
    const events = [{ type: "page_ready", data: { stage: "page", clientEnv: "extension" } }];
    try {
      for (const transport of [
        async () => {
          throw new TypeError("Failed to fetch");
        },
        async () => ({ ok: true, status: 202, json: async () => JSON.parse("<html>") }),
      ]) {
        globalThis.fetch = transport;
        for (const call of [
          () => fetchProviderData("provider-one", bound()),
          () => updateSessionStatus(bound(), "PROOF_GENERATION_STARTED"),
        ]) {
          const error = await call().then(
            () => null,
            (e) => e,
          );
          assert.equal(failureCode(error, "CONFIG_REJECTED"), "BACKEND_UNREACHABLE");
        }
      }
      globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch");
      };
      await assert.rejects(postTelemetry(bound(), events), /BACKEND_UNREACHABLE/);

      const expired = route();
      expired.authority.validUntil = "2000-01-01T00:00:00.000Z";
      const error = await fetchProviderData("provider-one", bound({ sessionRoute: expired })).then(
        () => null,
        (e) => e,
      );
      assert.equal(failureCode(error, "CONFIG_REJECTED"), "SESSION_EXPIRED");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records only the attestor selected for the session", () => {
    const proof = {
      claim: { identifier: "claim" },
      signatures: { attestorAddress: witness, claimSignature: { 0: 1 } },
    };
    assert.equal(formatProof(proof, {}, route()).witnesses[0].url, approved.attestorUrl);
    proof.signatures.attestorAddress = `0x${"e".repeat(40)}`;
    assert.throws(() => formatProof(proof, {}, route()), /witness/);
  });

  it("rejects expired authority, credentials and foreign sessions at lifecycle use", () => {
    assert.equal(requireLiveSession(bound()).route.backendUrl, approved.backendUrl);
    const expired = route();
    expired.authority.validUntil = "2000-01-01T00:00:00.000Z";
    assert.throws(() => requireLiveSession(bound({ sessionRoute: expired })), /SESSION_EXPIRED/);
    const { umia } = fixture();
    assert.throws(
      () => requireLiveSession(bound({ umia: { ...umia, expiresAt: "2000-01-01T00:00:00.000Z" } })),
      /SESSION_EXPIRED/,
    );
    assert.throws(
      () => requireLiveSession(bound({ sessionId: "other-session" })),
      /route mismatch/,
    );
    assert.throws(() => requireLiveSession(null), /route mismatch/);
  });

  it("dates a bound session's end by its earliest credential expiry", () => {
    const session = bound();
    const authExpiry = session.umia.attestorAuth.data.expiresAt * 1000;
    assert.equal(
      boundSessionDeadline(session),
      Math.min(
        authExpiry,
        Date.parse(session.umia.expiresAt),
        Date.parse(session.route.authority.validUntil),
      ),
    );
    const earlyAuthority = route();
    earlyAuthority.authority.validUntil = new Date(authExpiry - 1000).toISOString();
    assert.equal(boundSessionDeadline(bound({ sessionRoute: earlyAuthority })), authExpiry - 1000);
  });
});
