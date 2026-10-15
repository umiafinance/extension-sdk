# Reclaim Protocol Browser Extension SDK

Trigger Reclaim zero-knowledge proof verification from your browser extension or website.

> Chrome **Manifest V3**. MV2/Firefox bundles are also included.

> **Umia fork.** This package is Umia's patched copy (see `PATCHES.md`), built into the Umia
> extension in `web/extension`. A verification always starts from a session the Umia API has
> already signed and bound to the user: no app secret ever reaches a browser, an extension or a page.

## Install

```bash
npm i @reclaimprotocol/browser-extension-sdk
```

## 1. Copy the SDK assets

Umia's extension build copies the SDK bundles and verifies the ZK circuit assets against
the pinned manifest. Follow the staging and build commands in
[`web/extension/README.md`](../../../web/extension/README.md#build), including the reviewed
activation and network config inputs. The former `install-assets.js` downloader was removed
because it did not verify circuit digests.

The mirrored Stwo WASM is checked against the installed ZK package before staging, so an
older prover cannot be packaged after an upgrade. Rebuild and reload the extension after
staging. The updated Stwo proof format requires an updated attestor verifier; proofs
created with the previous format must be regenerated.

The default proof engine is `stwo`. The deployed devnet attestor now supports the
updated Stwo proof format. The published GitHub recipes leave the engine unset and
therefore use this default. Select `snarkjs` only for an explicitly scoped sandbox;
its current AES circuits have not been approved for eligibility gates.

Transcript chunk proofs run in up to four extension workers per claim. Workers
stop when the claim finishes or is cancelled, so switching engines does not
retain a second pool. A crashed worker can retry once in a new worker; a worker
proof timeout fails the claim without rerunning that proof on the offscreen thread.
Set `ZK_WORKER_POOL_SIZE=0` at build time to use the stock in-thread prover.
The pool reduces local proving time; Stwo claims can still spend much longer
uploading their multi-megabyte proof payloads to the attestor. Stwo proof blobs
are compressed individually when the browser supports `CompressionStream` and
the result is smaller. The attestor must support this proof format. WebSocket
message compression stays disabled.

## 2. Update your manifest

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';"
  },
  "host_permissions": ["<all_urls>"],
  "permissions": ["offscreen", "cookies", "scripting", "storage"],
  "content_scripts": [
    {
      "js": ["reclaim-browser-extension-sdk/content/content.bundle.js"],
      "run_at": "document_start",
      "matches": ["<all_urls>"]
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "reclaim-browser-extension-sdk/interceptor/network-interceptor.bundle.js",
        "reclaim-browser-extension-sdk/interceptor/injection-scripts.bundle.js",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.css",
        "reclaim-browser-extension-sdk/content/components/reclaim-provider-verification-popup.html"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

All of it is required. `wasm-unsafe-eval` runs the ZK prover, `offscreen` hosts it, `cookies` reads the provider's auth session, and `scripting` runs reviewed provider scripts in the provider tab. Only the page-injected bundles and the popup template are web-accessible: the offscreen document and its circuits load inside the extension, and a page that could frame them would receive every proof request.

## 3. Initialize the background

```js
// service worker (background.js)
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

reclaimExtensionSDK.initializeBackground();
```

## 4. Start a verification

The page never initializes a request itself. It asks the Umia API for a bound session config and
hands that config to the SDK; the API keeps the app secret and signs the session server-side.

```js
import { reclaimExtensionSDK } from "@reclaimprotocol/browser-extension-sdk";

// The Hub's authenticated call; the API binds the session to the signed-in user and wallet.
const { config } = await api.post("/api/v1/hub/zktls/proof-request", {
  providerId,
  providerVersion,
  walletAddress,
  target,
});

const request = reclaimExtensionSDK.fromJsonString(config, {
  extensionID: "your-chrome-extension-id",
});

request.on("completed", (proofs) => console.log(proofs));
request.on("error", (err) => console.error(err));

await request.startVerification();
```

The config carries a `umia` block (session token, attestor auth, network pin) that the fork checks
before it opens the provider's site. The Hub's real call site is `requestProof` in
`web/hub/lib/zktls-extension.ts`. Do not call `init(APP_ID, APP_SECRET, …)` from any client code:
that is the upstream hosted pattern, and the Umia flow never uses it.

## Troubleshooting

| Issue                                | Fix                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `Unexpected token 'export'`          | Load `content.bundle.js` from the manifest, not an ESM file                                              |
| `must specify Extension ID`          | Pass `{ extensionID }` when starting from a web page                                                     |
| Provider tab never opens             | Check `initializeBackground()` ran and the content script is registered                                  |
| Proof generation fails               | Rebuild using the staged pinned assets; check `web_accessible_resources` includes both circuit folders |
| Assets missing after a fresh install | Restage and verify assets as described in `web/extension/README.md#build`                              |
