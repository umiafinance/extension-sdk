# Extension SDK fork baseline and patch inventory

This directory is the vendored upstream SDK plus Umia's self-host patch set. It is
**not release-ready** until the open rows below land and devnet browser acceptance
passes. `web/extension` builds its background, content and offscreen bundles from this
workspace package, and `web/hub` loads its request API (`build:sdk`) for bound sessions.

The public source mirror is <https://github.com/umiafinance/extension-sdk>.
From a committed monorepo checkout, run `just update-extension-sdk-mirror` to
sync this directory to the mirror. This package uses `workspace:*` dependencies;
build and test it from the Umia monorepo using the commands below.

**Bound sessions only.** This fork serves only Hub-bound self-host sessions:
`startVerification` refuses a request without the nested `umia` block, and no
page-callback or unbound submission path remains. A store release of an extension
built on it uses deferred publishing and goes live at cutover (spec decision 2).

## Provenance and updating

- Upstream: <https://github.com/reclaimprotocol/reclaim-browser-extension-sdk>
- Release branch: `codex/release-0.5.2`; commit: `bba0264f640777b0202898d4270d8836507ecb6b`
  (upstream has not published a `v0.5.2` tag).
- Upstream package version: `0.5.2`; package metadata declares `MIT`. The release tree
  contains no standalone `LICENSE` file. Keep the upstream copyright notices and
  license metadata when updating.
- Attestor client: `@reclaimprotocol/attestor-core` **exactly `5.1.5`**. Its version
  must remain coordinated with backend and infrastructure decisions.
- Original import: `git subtree add --prefix shared/reclaim-extension-sdk reclaim-extension-upstream v0.5.1 --squash`

Upstream 0.5.2 overrides downloaded Stwo WASM with the release package's copy.
Umia removes that unverified downloader and stages a digest-pinned mirror of the
same `@reclaimprotocol/zk-symmetric-crypto@5.1.7` WASM. The change addresses
the Stwo public-input binding finding. The separate TLS application-key binding
finding remains unresolved upstream.

The upstream remote is local Git configuration, so add it in each checkout before a
future update:

```bash
git remote add reclaim-extension-upstream https://github.com/reclaimprotocol/reclaim-browser-extension-sdk.git
git fetch reclaim-extension-upstream --tags
git subtree pull --prefix shared/zktls/extension-sdk reclaim-extension-upstream vNEXT --squash
```

Run repository preflight before the commit-producing `git subtree pull`, then resolve
and check any local patch conflicts. Generated `build/`, `dist/`, and `zip/` remain
ignored. The upstream `package-lock.json` is untracked through the root `.gitignore`;
the monorepo's `bun.lock` is the authoritative workspace install lock. A subtree pull
that touches it needs `git rm --cached shared/zktls/extension-sdk/package-lock.json`.

The build-only changes to tagged files are in `package.json` and
`webpack-build-utils/build.js`: the workspace name, `private: true`, `author: "Umia"`, removal of
`prebuild`, removal of the npm publishing metadata and unused dependencies listed below, an exact `parse5-htmlparser2-tree-adapter@8.0.0` pin, direct
`ejs@3.1.10` dev dependency, and a nonzero exit code when webpack stats contain
errors. Upstream `prebuild` executes
`prettier --write .`, which would rewrite the imported source during an ordinary build.
The adapter pin is required because `8.0.1` brings `domhandler@6`, while the
vendored `patch-parse5-tree.js` patches `domhandler@5` prototypes; under a fresh
Bun resolution, 16 XPath tests fail with “Context node does not appear to be a
valid DOM node.” The upstream npm lock resolves adapter `8.0.0`. The webpack
config requires `ejs` for its HTML template without declaring it; npm hoisted a
transitive copy but an isolated Bun workspace did not. Upstream's build callback
also returned success when webpack stats reported those missing-module errors.
Neither change alters runtime source or webpack configuration. This document is
Umia-owned. Biome excludes the
upstream directory; Umia-owned CI and scanner scripts outside it remain linted normally.
Removed from the tagged `package.json` because nothing in the private workspace used them:
`module`, `files`, `keywords`, `overrides` (Bun reads overrides only from the root manifest), the
`postinstall1`, `format` and `prepublishOnly` scripts, the React/Redux/router, `tailwindcss`,
`web-vitals`, `web3` and `child_process` dependencies, the ESLint, Prettier, bundle-analyzer, CLI,
reloader, polyfill-typing and unreferenced loader/plugin dev dependencies, and the dev copies of
five browserify polyfills already listed in `dependencies`. Production builds before and after
the removal are byte-identical across all 25 files.
The two dependency names still shared with the root catalog (`@types/node`, `typescript`) have
incompatible major versions. Their upstream ranges remain local to this package;
changing the root catalog would alter unrelated packages. The other upstream
dependencies retain their tagged ranges apart from the adapter and direct `ejs`
build pin, and are pinned transitively by `bun.lock`.
The root trust list adds only the newly resolved `@parcel/watcher@2.6.0` and
`core-js-pure@3.50.0` after inspecting their install scripts. The watcher
invokes `node-gyp` only when `npm_config_build_from_source=true`; that path may
fetch build headers. Outside CI, core-js-pure's postinstall prints a funding
banner and writes a temporary `core-js-banners` cache. Their locked integrity
values are `sha512-7FNeNl8NCE7aINx7WXiKQrPYZWC/hvrTsmk6zmxbI7LTXE7hVek/n8AfVgpe2y82zl3w0HvCHN0bVKMBoJcC0w==`
and `sha512-6GP3Pxz4IKyWjAfa747vIu/jilB5z29JWROLqH/b+pXVcpgh6tM06ZIBwSuglgVqzDYURhOK6oEzTrG0bCHitA==`,
respectively. This satisfies the monorepo's supply-chain audit without changing
their source or versions.

## Reproducing the baseline

Use Node `24.14.1` and Bun `1.3.5` (the versions used for this baseline):

```bash
bun install --frozen-lockfile
bun --filter @umia/reclaim-browser-extension-sdk test
bun --filter @umia/reclaim-browser-extension-sdk build
bash scripts/zktls-sdk-domain-scan.sh
```

For a second production build, run the same `build` command again. Upstream's build
script deletes `build/` before each webpack run. Hash the files in `build/` after each
run and compare the sorted SHA256 lists. Do not run `prettier --write` on this subtree.
The scanner rejects absent runtime artifacts and scan errors. Its `--strict` mode is
the release gate: CI runs it on every build, and it fails on any forbidden host.

Observed on 2026-10-09 at the first #2812 head `c36dcf73f` (feature head `aad744c10` plus
the whole-branch review fixes): 163 Node and 50 Bun tests passed with no skips; two
production builds from a clean `build/` matched byte for byte across all 25 files
(sorted SHA256 manifest hash
`39d944f9a8743b72cf486688d3767b757f8d58f7248b7e1fc7d2b5af51d6b8fe`); `--strict`
reported no forbidden host.

Cross-checkout reproducibility, observed on 2026-10-09 with the permission-gate fold:
webpack used to inline attestor-core's `import.meta.url` as an absolute `file://` path
under `node_modules`, so `offscreen/offscreen.bundle.js` and its map differed between
checkouts. `webpack-build-utils/stable-import-meta-url.js` now emits the module's path
from its package root instead. Only attestor-core's Node-only local file fetch reads that
value; browser circuits still resolve from the extension-relative base. Two checkouts at
different absolute paths, each with its own `bun install --frozen-lockfile`, produced
byte-identical builds (25 files). At commit `0473cb81d` (after the #2812 session-end merge)
the sorted SHA256 manifest hashes to
`dc8835f2e2bf0fa76dac83124e7a76ff9595da4a7ec788b504a223a6288aae16`, also reproduced by the
#2817 reviewer in two separate checkouts. With the plugin removed, the second checkout
differed in exactly the offscreen bundle and its map. Manifest hashes are per commit: any
change to the SDK or its inputs changes them, so compare builds of one commit rather than
these literals.

The original baseline import record follows.

Observed on 2026-10-07 in an isolated fresh copy of the **final** monorepo lock:

- `bun install --frozen-lockfile`: 5,587 packages installed, no credentials.
- `bun --filter @umia/reclaim-browser-extension-sdk test`: 173 passed, 0 failed,
  0 skipped. The installed attestor parity cases ran under this Bun resolution.
- Two `bun --filter @umia/reclaim-browser-extension-sdk build` production runs:
  all 25 files in `build/` matched byte for byte. Each sorted SHA256 manifest
  hashes to `cb792a22be2a0bba1cb99333f19214563523fd1158da2ae0b8ccdf4a311964d3`.
  Webpack emitted size warnings, no compilation errors.
- A separate clean workspace copy has different hashes for only
  `offscreen/offscreen.bundle.js` and its map: the bundle embeds an absolute
  `file://` path to attestor-core's `attestor-browser.min.mjs` under that copy's
  `node_modules`, changing the map's generated-code positions. The two builds
  within each copy match; this was not a cross-checkout claim (fixed since, see above).
- In a disposable copy without `ejs`, webpack reported two template compilation
  errors and the patched build driver exited `1`. Before the exit-code fix, the
  same errors returned `0` and left only 8 of the expected 25 files.
- Before the adapter pin, the initial Bun install ran 173 tests with 157 passed
  and 16 XPath failures. Pinning `8.0.0` restored all 173 without changing tests.

The separate, untouched upstream npm baseline used `npm ci --ignore-scripts
--legacy-peer-deps`, ran 161 passing tests with 1 explicit parity skip and no
failures, and produced identical SHA256 manifests for 25 files across two clean
builds. Its webpack version was `5.101.0`; the final Bun lock resolves `5.109.2`,
so compare each build pair within its own install, not across package managers.

The unmodified upstream test suite has an explicit skip in
`src/utils/claim-creator/attestor-parity.test.js`: under this Node install,
`@reclaimprotocol/attestor-core` cannot import `@reclaimprotocol/tls/lib/index`.
The copied-fixture extraction test passes, but that is **not** a successful
runtime parity check against the installed attestor. No browser proof run was
performed for this import-only baseline.

### Artifact and install layout

The checked exports in `package.json` resolve to `build/ReclaimExtensionSDK.bundle.js`,
`build/background/background.bundle.js`, `build/content/content.bundle.js`,
`build/offscreen/offscreen.bundle.js`, and the two bundles in `build/interceptor/`.
The complete final build also contains `build/offscreen/offscreen.html`,
`build/offscreen/load-s2circuits.js`, content popup HTML/CSS, and
`build/scripts/install-assets.js` in the historical baseline. The installer is now removed;
`webpack.config.js` copies local
`node_modules/snarkjs/build/snarkjs.min.js` to
`build/browser-rpc/resources/snarkjs/snarkjs.min.js`; the file was present in
the final output. The Umia extension setup copies verified circuits from the
pinned asset mirror instead of downloading them through the SDK.
Infrastructure's proposed digest manifest concerns eight circuit objects only;
SDK bundles and `snarkjs.min.js` stay local, without a mirror in this baseline.
Asset schema, base URLs, and consumer imports still need reviewed integration artifacts.

## Runtime implementation and remaining patches

### Runtime slice 1: bound session routing

The fork now carries the canonical nested `umia` block through `fromConfig`,
verification template creation, background state and offscreen messaging. An
extension-owned per-session resolver supplies only the canonical activation
`{ profile, authority }`; the background checks the caller's top frame, exact endpoint profile,
Monad-only devnet chain 10143, authority reference, expiry, the signed auth (which
must end before both the session and the authority) and the pinned provider version
before fetching provider data or opening a tab. A rejected start reaches the caller
only as `CONFIG_REJECTED`, `SESSION_EXPIRED` or, for devnet Base 84532,
`UNSUPPORTED_NETWORK`. The background then carries one frozen bound session
`{ sessionId, umia, route }` through background and offscreen work: the route
alone holds destinations and authority, and `umia` keeps only the session
credentials. Bearer calls and proof generation recheck its expiry. Backend
provider/status requests use the session bearer and reject redirects.
Bound proof generation runs on a session-isolated client with the exact signed
auth (`src/offscreen/session-attestor.js`). Bound proofs go only to the private
`/session/:id/proof` intake with the session bearer, the accepted status is
polled, and accepted proofs reach only the initiating top-frame document
(`submitBoundProofs`, `sessionManager.submitProofs`); the upstream page-callback
submission and the popup/runtime proof broadcasts are removed.
Raw SDK init remains unbound even if an unexpected private field appears in its
response; self-host verification consumes the trusted Hub's serialized config.

The canonical endpoint rows remain structural candidates and are not activated
by the SDK. The consumer must supply a trusted resolver; the API must enforce
the bearer/session/provider binding. Attestor auth decoding, fresh per-session
sockets and their teardown have landed (see the lifecycle rows below). The bound
custom-injection patch removed the page-world helper that held
`api.reclaimprotocol.org`, and the telemetry patch removed the
`logs.reclaimprotocol.org` sink, so a production build contains no
`reclaimprotocol.org` host. None of this has passed a real browser run yet.

The table below records the original import gaps. Rows marked **Landed** or
**Implemented** are done in source; the rest track later work.

| Area                                                  | Exact seam and observed baseline                                                                                                                                                                                                                                                                                                                                                                                                                       | Patch to review after the interface spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend URL and origin binding                        | `src/utils/constants/constants.js` fixes `BACKEND_URL` and all `API_ENDPOINTS`; `src/ReclaimExtensionSDK.js` `_initSession` uses it. `src/utils/fetch-calls.js` uses the same endpoints for provider lookup and session updates.                                                                                                                                                                                                                       | **Landed.** `API_ENDPOINTS` take the backend from the bound session route, which `authorizeStart` (`src/utils/session-config.js`) selects from the extension's resolver and the exact `ZKTLS_EXTENSION_ORIGIN_ALLOWLIST` profile; no Reclaim or build-time backend constant remains. Raw `_initSession` routes through the caller's own profile and stays unbound. |
| Caller versus provider authorization                  | `web/extension/src/providerPermissionGate.js` `findOptionalPatternForUrl` drops the port and broadens HTTPS grants to the final two DNS labels. The SDK's `src/background/messageRouter.js` receives `START_VERIFICATION` through the content relay.                                                                                                                                                                                                   | **Landed.** `authorizeStart` checks the relayed `START_VERIFICATION` sender itself (extension ID, top frame, tab, document, exact caller origin) before any resolver call, separately from provider host grants. |
| Session config plumbing                               | `src/ReclaimExtensionSDK.js` `fromConfig` (lines 127–155) selectively copies known fields; `_startVerificationInternal` (lines 248–263) independently builds `templateData`. `src/background/sessionManager.js` copies fields into context and resets them for a new session.                                                                                                                                                                          | **Landed.** `fromConfig` freezes the nested `umia` block, `verificationTemplate` (`src/utils/session-transport.js`) carries it, and the background replaces it with one frozen bound session `{ sessionId, umia, route }`. |
| Attestor URL and proof witness                        | `src/utils/claim-creator/claim-creator.js` `createClaimObject` fixes `client.url` to `wss://attestor.reclaimprotocol.org:444/ws`; `src/offscreen/offscreen.js` passes that claim to `createClaimOnAttestor`. `src/utils/proof-generator/proof-formatter.js` `formatProof` separately fixes the proof witness URL without port `444`.                                                                                                                   | **Landed.** The claim's client URL and the reported witness URL both come from the bound route; `formatProof` rejects a proof whose attestor address is not the route's lowercase witness. |
| Attestor authentication encoding and transport        | `createClaimObject` currently sets only `client.url`. `src/utils/proof-generator/proof-generator.js` sends `claimData` through Chrome messaging; `src/offscreen/offscreen.js` calls `createClaimOnAttestor`. The pinned attestor exposes `IAttestorClientInitParams.authRequest` and protobuf `AuthenticationRequest` (`node_modules/@reclaimprotocol/attestor-core/lib/types/client.d.ts` and `lib/proto/api.d.ts`); it is not a generic HTTP header. | **Landed.** The JSON-safe signed `attestorAuth` crosses Chrome messaging inside the frozen bound session; offscreen decodes its signature into the attestor's `authRequest` (`signedAuthRequest` in `src/offscreen/session-attestor.js`) and discards any page-supplied auth. attestor-core is pinned at `5.1.5`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Authenticated socket isolation                        | Backend inspection of attestor-core `243f8a8355833f4eaa8afe6e67365098bbb78299`, `src/client/utils/attestor-pool.ts:4-34`, found a URL-only client pool. A fresh auth request can reuse an open socket and inherit its original host whitelist. This SDK's live offscreen call is `src/offscreen/offscreen.js` `createClaimOnAttestor`.                                                                                                                 | **Landed.** `BoundAttestorSessions` opens a fresh client and socket per session/auth identity and closes it on replacement, cancellation, completion, offscreen `pagehide` and at the bound-session deadline (`boundSessionDeadline`); offscreen drops late results after a close, and the background accepts a reply only for its own `transportRequestId`, session and extension sender. The background also tears an idle expired session down at that deadline with `SESSION_EXPIRED` (only terminal paths clear that timer, never the per-proof timer resets), and the initiating document's `pagehide` cancels its session, since proofs can be delivered only to that document. Server-side lifetime enforcement remains **unapproved** and outside this work.                                                                                                                                                                                                                                                                                   |
| Backend bearer calls                                  | `src/ReclaimExtensionSDK.js` `_initSession` and `src/utils/fetch-calls.js` `fetchProviderData` / `updateSessionStatus` use client-source headers without a session bearer. `submitProofOnCallback` sends to a consumer URL, not the backend.                                                                                                                                                                                                           | **Landed.** `sessionHeaders` attaches the session bearer only to the bound backend's provider, status, telemetry and proof-intake calls, rejecting redirects. The upstream page-callback submission is removed, so the bearer never reaches a page callback or the MAIN world. |
| Telemetry destination and scrub                       | `src/utils/logger/constants.js` fixes `DIAGNOSTIC_LOGGING` to `logs.reclaimprotocol.org`; `src/utils/logger/LoggingHub.js` `_flushOnce` sends batches. `src/utils/logger/redact.js` redacts at INFO, while the FINE mode can send raw claim material. `web/hub/lib/zktls-debug.ts` shows Umia's narrow client breadcrumb fields.                                                                                                                       | **Implemented (telemetry).** The hosted endpoint is gone and `LoggingHub` is console-only: no queue, storage mirror, flush schedule or device ID. `src/background/telemetry.js` sends only fixed `page_ready`, `permission_requested`, `permission_granted` and `request_captured` events (offscreen's status update already records `proof_started`) with a fixed `stage` and `clientEnv` to the bound route's `/api/sdk/telemetry` with the session bearer, at most 20 per session per 5 s. Cancel notifications carry only `CANCELLED`. Finite codes for other failure messages remain open.                                                                                                                                                                                                                                                                                                               |
| Structured errors and cancellation                    | `src/ReclaimExtensionSDK.js` and `src/content/content.js` emit string/Error values for failed verification. `src/background/sessionManager.js` cancellation path writes `PROOF_GENERATION_FAILED`; status/action names live in `src/utils/constants/interfaces.js`.                                                                                                                                                                                    | **Implemented (finite failures).** `failureCode` in `src/utils/constants/interfaces.js` maps any reason onto the closed `ZKTLS_ERROR_CODES` enum (`UNKNOWN` otherwise). `failSession` and the proof-submission failure paths send only that code to the page, the provider-tab popup and the backend; content re-checks every `VERIFICATION_FAILED` relay; the extension permission gate passes `PERMISSION_DENIED`/`PROVIDER_UNAVAILABLE`. An expired bound session throws `SESSION_EXPIRED`, and a network, redirect or unreadable-body failure from the bound backend throws `BACKEND_UNREACHABLE`, so both pass through unchanged. Cancel carries `CANCELLED`. Offscreen reports a proof timeout or a socket that never opened as `ATTESTOR_UNREACHABLE`; an attestor rejection carrying a finite `data.reason` (#2833), thrown or in the claim response, as the code `ZKTLS_ATTESTOR_REJECTION_CODES` maps it to; otherwise invalid signed auth, whether caught locally or rejected by the attestor (`ERROR_AUTHENTICATION_FAILED`), as `ATTESTOR_AUTH_FAILED` and any other attestor failure as `PROOF_GENERATION_FAILED`; a proof-submission outage is `BACKEND_UNREACHABLE` and a rejection `VERIFICATION_FAILED`. A `PROOF_GENERATION_FAILED` status update carries the same `code` the page receives (the API's allowlist must land first); a cancellation keeps `SESSION_CANCELLED`. A session ends once (active → ending → ended): the trigger that claims the end owns delivery and sends one terminal outcome from the state captured at the claim; a later trigger only records its code, which a failing submission reports, and a tab close no longer clears state the owner needs. A table test covers every ordered pair of failure, cancel, tab close, expiry, page teardown and submission success/failure, and a late filtered request is dropped. A source test fails if any failure call site passes text.                                                                                                                                                     |
| Permission gate: all frames                           | The consumer's `web/extension/src/providerPermissionGate.js` `runReconcile` registers `allFrames: true`; upstream content interception otherwise misses provider requests in iframes.                                                                                                                                                                                                                                                                  | **Landed.** `providerContentScript()` (`src/background/providerAccess.js`, exported as `@umia/reclaim-browser-extension-sdk/provider-access`) builds the dynamic registration with `allFrames: true`; the consumer passes only its script ID, granted matches and patch CSS. |
| Permission gate: frame 0                              | The consumer's `wrapTabsSendMessage` pins popup creation to `frameId: 0`; upstream `src/background/messageRouter.js` broadcasts the popup message.                                                                                                                                                                                                                                                                                                     | **Landed.** The router sends the pending `SHOW_PROVIDER_VERIFICATION_POPUP` with `{ frameId: 0 }`; the consumer's `tabs.sendMessage` wrapper is gone. |
| Permission gate: request hosts                        | The consumer's `providerRequestPatterns` and `gateProviderTab` derive grants from `providerData.requestData[].url` as well as the login URL. Upstream `src/background/sessionManager.js` opens the provider tab without those grants.                                                                                                                                                                                                                  | **Landed.** `providerRequestUrls(providerData)` returns the provider's request URLs; the consumer maps them through its own optional-permission pattern rule before the provider tab opens. The gate reports `permission_requested` and `permission_granted` session telemetry (fixed `permission` stage, no host) when it prompts and when access is granted. |
| Permission gate: popup stacking                       | `web/extension/public/popup-patches.css:4-6` raises `#reclaim-protocol-popup` to `z-index: 2147483647` above host modals. `web/extension/src/providerPermissionGate.js` registers that CSS through `POPUP_PATCH_CSS_PATH` in `runReconcile`; `agents/docs/workflow/zktls-providers.md:173` records the host-modal failure.                                                                                                                               | **Landed.** The popup sets an important inline `z-index: 2147483647` from creation, and the SDK stylesheet uses the same value; `web/extension/public/popup-patches.css` keeps only its proof-wait notice. |
| Grant-window reuse                                    | The consumer's `web/extension/src/providerPermissionGate.js` `reuseOrOpenGrantWindow` reuses a pending grant window; upstream can reissue tab opens during one verification.                                                                                                                                                                                                                                                                           | **Consumer-owned by design.** The grant window and its reuse belong to the consumer's permission UI (`reuseOrOpenGrantWindow`); not part of the fork. |
| Hidden geo dependency                                 | `src/utils/claim-creator/get-dynamic-geo.js` calls `api.country.is`, `ipwho.is`, then `ipapi.co` for `{{DYNAMIC_GEO}}` in `createClaimObject`.                                                                                                                                                                                                                                                                                                         | **Implemented (no geo lookup).** `pinnedGeoLocation` accepts only a fixed two-letter code or none from the pinned recipe and rejects `{{DYNAMIC_GEO}}` with `CONFIG_REJECTED` in `fetchProviderData`, before any tab opens; no IP lookup remains. `scripts/zktls-sdk-domain-scan.sh` forbids these hosts and CI runs it with `--strict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Hidden custom injection dependency and trust boundary | `src/interceptor/injection-scripts.js` exposes `fetchProviderInjectionScript` to the page, with a Reclaim URL, but its automatic loader reads page `localStorage` instead. `src/content/content.js` stores `providerData.customInjection` there. `src/background/messageRouter.js` `RUN_CUSTOM_INJECTION` currently executes message-supplied `data.code` in MAIN.                                                                                     | **Implemented (bound injection).** `fetchProviderData` pins ID, version, `recipeDigest` shape and the single versioned HTTPS login URL. Content gets a code-free copy and sends only `INJECT_VIA_SCRIPTING {op: "RUN_CUSTOM_INJECTION"}`. `src/background/injectionManager.js` checks extension sender, live bound session, managed active tab, top frame, active `documentId`, login-URL origin (sender and tab) and `customInjectionSha256`, then runs the code once per document in MAIN via `documentIds`; stale results are dropped and uncertain runs never repeat. The hosted loader, localStorage code/provider-ID paths, page provider-ID bridge and the unbound `REPLAY_PAGE_FETCH` are removed. **Bound document replay** replaces that op. A server-rendered document loads before the page-world interceptor exists, so a recipe whose request is the page itself never matched; GitHub's settings page is one example. The old op re-requested any `location.href` with the user's cookies, for any tab, on every URL change. Content now sends only `{op: "REPLAY_BOUND_DOCUMENT"}`. `runBoundReplay` applies the same sender, session, tab, document and login-origin checks as custom injection. It then takes the URL from `chrome.tabs.get` only, and requires it to equal the sender's URL, be on a host in the signed attestor whitelist, and fully match a reviewed `requestData` entry declared as GET with no sniffed body. The match is against the whole URL, so the query must equal the declared one: the same parameters, in order, with nothing extra. A template variable uses the request matcher's `{{name}}` grammar. In the path it may not contain `/`, `?` or `#`; in the query it may not contain `&`, `=` or `#`. In the bound document only, and only if `location.href` still equals that URL, it sends one credentialed same-origin XHR with fixed accept headers and no marker header, which the interceptor captures. Each (document, URL) pair is reserved before any await and replayed at most once, with at most 3 replays per session. If the page moved or the interceptor isn't loaded yet, nothing is sent and a retry is allowed. An absent `disableRequestReplay` allows replay, as upstream does; only `true` disables it. Ported recipes often omit the field, and the replayed request is exactly the declared request the claim needs, under every other guard. The upstream CSP-stripping rule (`cspRuleManager.js`) is deleted: it was not tab-scoped and the Umia manifest has no `declarativeNetRequest*` permission, so strict-CSP pages fail closed. |     |

**Security audit 2026-10-10 (#2858).** A claim's criteria come from the pinned recipe entry its
`requestHash` names, never from the page; an entry without a unique stored hash is keyed by its
position when the provider is fetched. The request must still match that entry and its host must be
signed, and only the live provider tab's top frame or a signed-host subframe may send it
(`src/background/claimRequest.js`). Page-reported `Cookie`/`Origin`/`Referer` headers are dropped.
The owner-key reply and `GET_PRIVATE_KEY` accept only this extension's own pages, and the offscreen
document and circuits are no longer web-accessible. Log config and relayed logs accept only
extension-internal senders, and no level prints a cookie, key or token.

The current bundles contain no `reclaimprotocol.org` host. No consumer switch, mirror, publish
job, deployment, or contract change is part of this slice.
Signed epoch `N` is wire-compatible only when the owner/witness authority is valid
for that beacon; this inventory does not imply every deployed contract can be reused.
Per-session `umia` routing uses the canonical selected authority; one epoch must
not be selected globally. The constructor/redeployment plan remains halted.

## Patch file inventory

Umia-owned files (no upstream counterpart; a subtree pull never touches them):
`src/utils/session-config.js`, `src/utils/session-transport.js`,
`src/utils/at-deadline.js`, `src/background/injectionManager.js`,
`src/background/telemetry.js`, `src/background/providerAccess.js`,
`src/background/claimRequest.js`,
`src/offscreen/session-attestor.js`, `src/utils/session-config.test.js`,
`src/content/components/reclaim-provider-verification-popup.test.js`,
`tests/*.bun.test.js`, `webpack-build-utils/stable-import-meta-url.js`,
`tsconfig.webpack.json`, this file and `CLAUDE.md`.

Upstream files Umia rewrote; resolve a pull by keeping the Umia version and porting any
upstream fix by hand: `src/utils/fetch-calls.js`, `src/utils/constants/constants.js`,
`src/utils/claim-creator/get-dynamic-geo.js`, `src/interceptor/injection-scripts.js`,
`src/utils/logger/LoggingHub.js` (and its README and test).

Upstream files with Umia hooks (expect conflicts here): `src/background/sessionManager.js`
(bound-only lifecycle, expiry timer, terminal guard, pinned delivery),
`src/background/messageRouter.js` (`authorizeStart`, owned cancel, finite start codes,
managed-tab guards), `src/background/background.js`, `src/background/proofQueue.js`,
`src/offscreen/offscreen.js`, `src/content/content.js` (code-free injection request,
finite failure relay, `pagehide` cancel), `src/ReclaimExtensionSDK.js`,
`src/content/components/reclaim-provider-verification-popup.{js,css,html}` (popup stacking,
Umia header, generic instructions because approved recipes contain no display name,
HTML-escaped session ID),
`src/utils/claim-creator/claim-creator.js`, `src/utils/proof-generator/*`,
`src/utils/session-timer.js`, `src/utils/constants/{config,interfaces}.js`,
`src/utils/logger/{constants,redact,RemoteLogger,index}.js`, `src/types/index.d.ts`,
`package.json` (the `./provider-access` export), `webpack.config.js` and
`webpack-build-utils/build.js`. Small comment,
doc or test edits: `readme.md`, `src/background/README.md`,
`src/interceptor/{log-bridge,network-interceptor}.js`,
`src/utils/claim-creator/{attestor-extraction.js,claim-shape.test.js}`,
`src/utils/logger/redact.test.js`. The upstream `examples/` directory is deleted: its demos used
Reclaim's hosted app secret and the published SDK, so they cannot run against bound sessions. A
subtree pull that brings it back should delete it again.
