# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@umia/zktls-extension-sdk` — Umia's vendored fork of upstream
`@reclaimprotocol/browser-extension-sdk` `0.5.2` (patch set and update procedure in
[PATCHES.md](PATCHES.md)). It lets a website or a browser extension trigger a zero-knowledge-proof
verification flow. The SDK opens the provider's site in a managed tab, intercepts
the page's network traffic, builds a claim from a matching request, generates a ZK proof in an offscreen
document (WASM), and submits/emits the proof.

This is a **library**, not a shippable extension. Its consumer is `web/extension`, whose
`scripts/setup.js` copies the prebuilt content, interceptor and offscreen bundles into its
`public/reclaim-browser-extension-sdk/` (they cannot be re-bundled) and whose service worker imports
the ESM SDK bundle. The Hub imports the same package for its page-side request API. Chrome MV3
primary, MV2/Firefox variants also emitted.

**Bound sessions only.** The fork serves only Hub-bound self-host sessions: `startVerification` refuses a
request without the nested `umia` block, and no page-callback or unbound submission path remains. A store
release of an extension built on it uses deferred publishing and goes live at cutover (spec decision 2).

## Commands

```bash
bun run build     # webpack over all 3 configs → build/ (prebuild prettier removed; see PATCHES.md)
bun run test      # node:test over src/**/*.test.js, then bun test ./tests
bun run test:build # after build: runs the built bundles' executeScript functions in a bare context
```

- [example-provider.test.js](src/utils/claim-creator/example-provider.test.js) is the closest thing to
  an end-to-end check: it takes the three `requestData` entries of the **published** `example` provider
  and walks a real request/response pair through `describeRequestMatch` → `extractParamsFromResponse`,
  asserting the parameter values a real session actually produced (2b46b57c39). It covers all three of
  that provider's redaction styles (`xPath+regex`, `jsonPath+regex`, `jsonPath+regex+hash`). It does
  **not** cover proof generation — that needs WASM, the ZK circuits and a live attestor socket. Update
  its fixtures if the provider is republished.
- Tests run on Node's built-in runner — no Jest. Source files are ESM `.js` in a package with no
  `"type": "module"` (webpack.config.js is CJS, so it can't be added), so Node falls back to module-syntax
  detection; `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` in the `test` script silences the resulting
  noise. **Relative imports in `src/utils/claim-creator/` need explicit `.js` extensions** — webpack
  resolves extensionless paths, Node's ESM loader does not.
- The test glob is quoted so Node expands it, not the shell. Don't pass a bare directory to `node --test`:
  it runs _every_ file in it, including non-tests like `src/utils/polyfill-test.js`.
- **Circuit assets use the pinned Umia mirror.** `web/extension/scripts/setup.js` verifies
  the copied assets; the old unverified `install-assets.js` downloader was removed.
- [webpack-build-utils/build.js](webpack-build-utils/build.js) sets production mode before loading
  the configs. `--sdk-only` builds just the public ESM entry for Hub; the default still builds
  all three extension targets. Both modes clean `build/`, so run the full build before packaging
  the extension. Progress is interactive-only; CI prints timings, warnings and errors.

### Verifying a change end to end

There is no dev server for the SDK itself. Its consumer is `web/extension`: rebuild the SDK with
`bun run build`, then build and load the extension as [its README](../../../web/extension/README.md)
describes. The upstream `examples/` were removed: they used Reclaim's hosted app secret and the
published SDK, which a bound-session fork cannot run.

## Architecture

### Contexts and entry points

| Context               | Entry                                                        | Notes                                             |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Consumer page / popup | [src/ReclaimExtensionSDK.js](src/ReclaimExtensionSDK.js)     | Public API surface                                |
| Service worker        | [src/background/background.js](src/background/background.js) | `initBackground()` returns `ctx`                  |
| Content script        | [src/content/content.js](src/content/content.js)             | Registered on granted sites; Hub relay or managed tab |
| Page (MAIN world)     | [src/interceptor/](src/interceptor/)                         | `fetch`/`XHR` patching                            |
| Offscreen document    | [src/offscreen/offscreen.js](src/offscreen/offscreen.js)     | attestor-core WASM + WebSocket, proof workers     |

The SDK detects its own mode in the constructor: `chrome-extension:` protocol → `"extension"` (talks to
background via `chrome.runtime.sendMessage`), otherwise `"web"` (talks to the content script via
`window.postMessage`, and `extensionID` becomes mandatory).

### The verification pipeline

```
Hub page            → POST /api/v1/hub/zktls/proof-request (API signs + binds) → config with `umia` block
fromJsonString()    → request (upstream SDK.init() signing with an app secret is never used client-side)
startVerification() → START_VERIFICATION → sessionManager.startVerification
                        ├─ fetchProviderData(providerId) from the bound session's backend
                        └─ chrome.tabs.create(loginUrl) → tab added to ctx.managedTabs
content script (managed tab) → injects network-interceptor into MAIN world
interceptor → INTERCEPTED_REQUEST_AND_RESPONSE → content.filterInterceptedRequests()
                        (polls every NETWORK_FILTERING_INTERVAL_MS against providerData.requestData)
match → FILTERED_REQUEST_FOUND {requestHash, request} → claimRequest.resolveClaimRequest
                        (pinned recipe entry by requestHash, re-matched; signed host only)
      → ctx.processFilteredRequest (background.js)
                        ├─ attach cookies (cookieUtils) + pageOrigin
                        ├─ createClaimObject (claim-creator)
                        └─ proofQueue.addToProofGenerationQueue
proofQueue → generateProof → offscreen document → attestor-core → proof
all requestHashes satisfied → sessionManager.submitProofs → private /session/:id/proof intake
                        → PROOF_SUBMITTED to the initiating document only
```

Non-obvious properties of this pipeline:

- **The background is single-session.** `ctx.activeSessionId` rejects a second concurrent
  `START_VERIFICATION`. The SDK therefore serializes calls through a module-level
  `_verificationQueue` in `ReclaimExtensionSDK.js`. Both guards exist; don't remove one assuming the
  other covers it.
- **Shared-context (`ctx`) pattern.** `initBackground()` builds one plain object holding all session
  state _and_ injected dependencies (`fetchProviderData`, `generateProof`, `MESSAGE_ACTIONS`,
  `loggingHub`, …), then binds module functions onto it (`ctx.failSession`, `ctx.submitProofs`). Every
  background module is a set of free functions taking `ctx` first — there are no classes and no module
  scope state. New session state belongs in the `ctx` literal _and_ in the reset block at the top of
  `sessionManager.startVerification`, which is what clears state between sessions.
- **Every terminal path must emit a terminal event.** The SDK's `startVerification()` returns a Promise
  resolved only by `completed`/`error`. Anything that ends a session (tab closed, provider error,
  concurrency rejection, `startVerification` throwing) has to route through `failSession` or send
  `PROOF_GENERATION_FAILED`, or the consumer's Promise hangs forever. `messageRouter` restores
  `ctx.sessionId` before calling `failSession` for exactly this reason — the SDK drops events whose
  `sessionId` doesn't match. A session ends once: active → ending → ended (`ctx.sessionEnd`). The trigger that claims the end
  (failure, cancel, expiry, tab close, page teardown or proof submission) owns delivery, and
  `finishSession` sends its one terminal outcome from the binding and tabs captured at the claim. A trigger
  that arrives meanwhile only records its code, which a failing submission reports in place of its own
  error. `tests/session-end.bun.test.js` checks every ordered pair of triggers.
- **Timers.** `SessionTimerManager` starts only on the _first_ intercepted request
  (`ctx.firstRequestReceived`) and fails the session if no proof lands within
  `SESSION_TIMER_DURATION_MS`. It is _paused_ across proof generation, so the 30 s window never kills a
  proof. That includes a claim queued behind another: the timer each proof restarts is cleared before
  the next queued claim generates, as a connected recipe's replay captures its requests together. All
  tunables live in [src/utils/constants/config.js](src/utils/constants/config.js) — put new
  timeouts there, not inline. Separately, `startVerification` arms an expiry timer at the bound
  session's deadline that fails the session with `SESSION_EXPIRED`, closes its offscreen client and
  returns from the provider tab. Only terminal paths and replacement call `clearExpiryTimer()`;
  `clearAllTimers()`, which the proof queue calls between proofs, leaves it armed.
- **The two proof timeouts are nested, and the outer one must stay the longer.**
  `PROOF_GENERATION_TIMEOUT_MS` (120 s) is the real budget — `offscreen.js` races
  `createClaimOnAttestor` against it. `PROOF_RESPONSE_TIMEOUT_MS` is the background waiting for the
  offscreen's reply, and is **derived** as `PROOF_GENERATION_TIMEOUT_MS + 15_000` rather than written as
  a literal, because it was once 60 s against an inner 120 s: the outer always won, a proof legitimately
  needing 60–120 s was killed while the offscreen was still working, and the inner timeout could never
  surface. The outer is now only a backstop for a document that died without answering.

  Both paths in [proof-generator.js](src/utils/proof-generator/proof-generator.js) reject with a real
  `Error` (via the local `rejection()` helper). They used to reject a bare `{success, error}` literal, so
  `error.message` in `proofQueue`'s catch was `undefined` — the session's one explanation of a proof
  timeout read `Proof generation failed: undefined`, and that string reached the consumer's Promise.
  `proofQueue` also reads `error?.message || error?.error` now, so the next plain-object rejection stays
  legible.

- **The content script — and its popup — is destroyed and rebuilt on every navigation.** It is injected
  at `document_start` on each page, and a multi-request provider routinely walks several origins: the
  stock `example` provider goes example.org → example.com → jsonplaceholder, re-running
  `PROVIDER_DATA_READY`, the interceptor injection and the popup construction each time. **Nothing
  accumulated in content-script state survives a claim boundary.**

  The popup's claim counter learned this the hard way. It counted `totalClaims` from the
  `CLAIM_CREATION_REQUESTED` messages it personally saw and `completedClaims` from
  `PROOF_GENERATION_SUCCESS`, both starting at zero on every page — so a real 3-claim session showed
  `1/1`, flashed `2/1` (completed can exceed a per-page total), and finished by rendering
  `totalClaims/totalClaims`, i.e. `1/1` again. Session 2b46b57c39 generated and submitted all three
  proofs correctly the whole time; only the display was wrong.

  The background is the only context that spans the navigations, so it owns the numbers:
  [claim-progress.js](src/utils/claim-progress.js) `claimProgress(ctx)` returns
  `{completed: ctx.generatedProofs.size, total: max(requestData.length, completed)}` — bound as
  `ctx.claimProgress()` for `proofQueue`, per the shared-context pattern — and rides along in both
  messages' `data.progress`. The popup renders what it is given and falls back to its old increment only
  when the field is absent. `total` takes the _larger_ of the two, so a counter never reads `4/3`.

  Its own module rather than a function in `background.js` so `node --test` can reach it: `background.js`
  uses extensionless imports, which webpack resolves and Node's ESM loader does not.

- **A rejected candidate is not a failed session.** Authoritative redaction resolution happens in the
  background, so it can legitimately conclude "this response doesn't carry the data yet".
  `processFilteredRequest` returns `{retryable: true}` for that case — no `failSession`, no
  `CLAIM_CREATION_FAILED` — `messageRouter` un-memoizes `ctx.filteredRequests`, and the content script
  pops the key back off `this.filteredRequests` so polling resumes. Skipping any one of those three
  stalls the flow until the session timer fires.
- **A conclusive criteria miss fails the session immediately.** `content.js` reports a complete,
  signed-in response that fails the recipe's rule ([criteria-result.js](src/content/criteria-result.js):
  a GitHub count below threshold, or a FOMO own profile that misses its hold-time or clan rule) as
  `RESPONSE_MATCH_RESULT`, and
  `sessionManager.recordResponseMatchResult` calls `failSession("CRITERIA_NOT_MET")` on the spot. It
  does not wait for the session timer: that used to add up to 30 s to an answer the extension already
  had. A FOMO profile counts only when its account equals the one the matched
  `/v2/users/current` response proved, so browsing another user's profile never fails the session.
  The one deferral is a claim already in flight for that entry (`ctx.filteredRequests`) — it keeps
  its chance, and the recorded miss turns a later timer expiry into `CRITERIA_NOT_MET` through
  `missingRequestCode`.

### The claim object must satisfy the attestor's schema exactly

`params` / `secretParams` are validated **server-side** by AJV against attestor-core's
`HttpProviderParameters` / `HttpProviderSecretParameters` (`src/types/providers.gen.ts`, applied in
`server/utils/validation.ts`). Both are `additionalProperties: false`, AJV runs `strict: true` with no
`removeAdditional`, so one unexpected key fails the whole claim with `ERROR_BAD_REQUEST: Params validation
failed` — at proof time, after the user has logged in, with the field named only inside an errors blob.

Provider documents legitimately carry fields that must **not** be forwarded (`order`, `description`,
`isOptional`, the legacy `responseSelections`), and that set grows independently of this SDK. So:

- [claim-shape.js](src/utils/claim-creator/claim-shape.js) `assertClaimShape()` is the last gate before the
  attestor: an **allowlist** of the schema's keys, plus string coercion of `paramValues` (AJV
  rejects a non-string) and a required-field check. It strips rather than throws — a dropped unknown field still yields an acceptable claim, whereas
  failing the session denies a verification over a field the attestor would have ignored.
- `responseRedactions` is likewise built as an allowlist (`xPath`, `jsonPath`, `regex`, `hash`). Empty
  `xPath`/`jsonPath` are omitted, not sent as `""`.
- **Never add a field to `params` without checking the schema first.**

**Hash-bearing params stay in `params.paramValues` — do not force them secret.** It looks like a privacy
win and breaks OPRF two ways: the attestor verifies response matches via
`substituteParamValues(rawParams, undefined, true)` — `secretParams` is _undefined_ there, and
`ignoreMissingParams` makes an unresolved `{{param}}` return **literally**, so the match is compared
verbatim and never matches; and `updateParametersFromOprfData` (default `true`) replaces the raw value with
the OPRF nullifier inside `params` only. Privacy comes from that client-side substitution, not from hiding
the param. InApp splits on the name containing `SECRET` and nothing else — match that.

### Provider values wider than this SDK supports

[provider-normalization.js](src/utils/provider-normalization.js) coerces provider config to what the
extension actually implements, at the point the provider is fetched, logging every coercion:

| field                       | upstream value space                       | supported here                                       | fallback                                                                                                                                        |
| --------------------------- | ------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `injectionType`             | `MSWJS \| XHOOK \| HAWKEYE \| NONE \| CDP` | `HAWKEYE` (inject the interceptor), `NONE` (don't)   | **`HAWKEYE`** — matches InApp's `defaultValue`. Never default to `NONE`: that silently disables interception and the session dies on the timer. |
| `responseRedactions[].hash` | `oprf \| oprf-mpc \| oprf-raw`             | `oprf-raw`                                           | **`oprf-raw`** for any other truthy value. Absent/`null` must stay absent — coercing it would hash a value the provider meant to reveal.        |
| `requestData[].urlType`     | `REGEX \| CONSTANT \| TEMPLATE`            | all three (`CONSTANT`/`EXACT` compare, others regex) | **inferred from the url** like InApp does: `TEMPLATE` if it contains `{{`, else `CONSTANT`. Never refuse to match — see below.                  |

`injectionType` is normalized in `sessionManager.startVerification` right after `fetchProviderData`, so
every downstream consumer sees a supported value; `messageRouter` sends `DEFAULT_INJECTION_TYPE` rather
than `null` when there is no provider data.

`urlType` is normalized where it is _used_ instead — in `matchesRequestCriteria`
([network-filter.js](src/utils/claim-creator/network-filter.js)), the one place it decides anything. Two
things to know:

- **There is no `EXACT` upstream.** The enum is `REGEX | CONSTANT | TEMPLATE` (InApp `UrlType`).
  `EXACT` is local to this SDK — `matchesRequestCriteria`'s historical default, and what the background
  writes on synthetic requests — so it is kept as an alias for `CONSTANT`, not removed.
- **An unrecognised `urlType` must never mean "no match".** This branch used to `return false` for
  anything outside its list, and `CONSTANT` — upstream's _default_, what InApp infers for any url without
  `{{` — was outside it. A provider carrying it matched no request at all: no claim, no proof, and no
  diagnostic past `REQUEST_INTERCEPTED`, because everything that logs about extraction runs only _after_ a
  match. It failed on the session timer looking exactly like "the user never logged in". Guessing wrong
  costs one non-matching request; refusing to match costs the whole verification, so unknown values are
  inferred from the url.

#### The gate reports which check rejected a request

This gate is upstream of every extraction log, so a provider that matches nothing used to be the one
failure mode with no signal at all: the six `return false` points were silent, and a stale `bodySniff`
template produced a session identical to "the user never logged in".

`describeRequestMatch()` is now the real entry point and returns `{matched, stage, detail}`;
`filterRequest()` is a thin boolean wrapper kept for callers that only need the verdict. `stage` is a
member of `MATCH_STAGES`, ordered by `MATCH_STAGE_ORDER` (`url → method → body → responseMissing →
responseMatch → responseRedaction → matched`), so **reaching stage N means every check before N passed** —
that ordering is what the content script's counters are built on.

- **`detail` becomes a log line, and log lines are never redacted.** Only provider-authored patterns
  (the url template, `bodySniff.template`, `match.value`, a redaction's `jsonPath`/`regex`) and _sizes_
  may appear in it. Never the request body, never the response. `network-filter.test.js` pins this.
- **Only near misses are logged individually.** `content.js` `reportMatchAttempt()` skips
  `MATCH_STAGES.URL` — 32 of 33 requests in a typical page load die there and it says nothing the
  `REQUEST_INTERCEPTED` line doesn't. `responseMissing` is FINE, being the normal state on the tick
  between a request and its response. Everything else is INFO.
- **Reporting is keyed on advancement, not on evaluation.** Filtering re-runs every
  `NETWORK_FILTERING_INTERVAL_MS` over the same request map for the life of the session, so
  `this.matchProgress` (`"<matcherIndex>|<requestKey>"` → furthest stage index) gates each line to the
  first time that pair gets that far. A request legitimately advances when its response arrives, so
  dedupe on "seen" rather than "advanced" would suppress the interesting outcome.

`reportNoMatchSummary()` closes the loop with one line per matcher (`N seen, N url-matched,
N method-matched, N body-matched, N fully matched`), fired by a content-script timer armed in
`startNetworkFiltering` and disarmed on the first match. This is the "no request ever matched" timer
`RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION` was waiting for — but it carries that event type
**only when nothing was intercepted at all**. With traffic seen it emits
`CLAIM_CREATION_TIMED_OUT_EXCEPTION`, which is what the background's session timer already calls the same
outcome. Deliberately **not** `FILTER_REQUEST_ERROR`: that marks a _thrown_ filtering error
(`background.js`), and folding a clean non-match into it would break that query.

The background's `SessionTimerManager` cannot do this job — it starts only on the first intercepted
request, so it cannot tell "no traffic" from "traffic, none matching", and the counters live in the
content script anyway.

### Vendored attestor code — must be re-synced by hand

A provider's `xPath` / `jsonPath` / `regex` is authored once and must resolve **identically** in
attestor-core, the InApp SDK, and this extension. To guarantee that, the extraction primitives are a
verbatim copy of the attestor's, not a reimplementation:

| file                                                                                   | upstream source                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [vendor/attestor-http-utils.js](src/utils/claim-creator/vendor/attestor-http-utils.js) | attestor-core `src/providers/http/utils.ts` (extraction half)                            |
| [vendor/patch-parse5-tree.js](src/utils/claim-creator/vendor/patch-parse5-tree.js)     | attestor-core `src/providers/http/patch-parse5-tree.ts`                                  |
| [attestor-extraction.js](src/utils/claim-creator/attestor-extraction.js)               | mirrors the private `processRedactionRequest` generator in `src/providers/http/index.ts` |
| [make-regex.js](src/utils/claim-creator/make-regex.js)                                 | `makeRegex`, using the attestor's browser `re2` fallback semantics                       |

Rules:

- **Do not "improve" the vendored files.** Any local edit silently breaks cross-SDK parity. Deviations are
  allowed only where the environment forces them, and each is commented (currently only `makeRegex`, which
  is `new RegExp(str, "sgi")` rather than `RE2(str, 'sgiu')` — the attestor's own browser build does the
  same, and webpack aliases `re2: false` here anyway).
- **After re-syncing, run `bun run test`.**
  [attestor-parity.test.js](src/utils/claim-creator/attestor-parity.test.js) drives the _installed_
  attestor through its `./external-rpc` `handleIncomingMessage` surface and diffs it against the copy, so
  it catches real divergence rather than just re-asserting copied expectations.
- The parsers (`xpath`, `parse5`, `parse5-htmlparser2-tree-adapter`, `domhandler`, `esprima-next`) are
  pinned to the attestor's exact ranges. Bump them together with a re-sync, not independently.
- **Keep them out of the content bundle.** They have import-time side effects (`patch-parse5-tree` mutates
  `domhandler` prototypes) so webpack cannot tree-shake them, and the content script is injected at
  `document_start` on every page of every site. That's why `content.js` imports `filterRequest` from
  `claim-creator/network-filter` directly rather than the `claim-creator` barrel, why `makeRegex` lives in
  its own module, and why the content-script gate has no `xPath` branch at all.

Why vendored rather than imported, now that the pinned 5.1.1 _does_ export the extractors
([PR #92](https://github.com/reclaimprotocol/attestor-core/pull/92)): `makeRegex` and the
`processRedactionRequest` redaction chain are still not in that export set, so local copies are needed
either way — and a half-imported, half-copied chain is harder to keep in lockstep than a wholly copied
one `attestor-parity.test.js` can diff end to end. That test runs on 5.1.1 (it skipped on 5.0.5), so the
copies are now checked against the real attestor on every `bun run test` rather than trusted.

### attestor-core is pinned to `5.1.5` exactly — do not bump it casually

`@reclaimprotocol/attestor-core` is pinned **without `^`**. Two independent regressions in the 5.0.x/5.1.x
line make several versions unusable, and neither fails at install time:

| version      | `./browser` bundle ships | bundle registers `stwo` |
| ------------ | ------------------------ | ----------------------- |
| 5.0.5        | yes                      | yes                     |
| 5.0.6        | yes                      | **no**                  |
| 5.0.7        | yes                      | **no**                  |
| 5.0.8        | yes                      | **no**                  |
| 5.1.0-dev.1  | yes                      | yes (but a prerelease)  |
| 5.1.0        | **no — 404**             | n/a                     |
| 5.1.1        | yes                      | yes                     |
| 5.1.3        | yes                      | yes                     |
| **5.1.5** ✅ | yes                      | **yes**                 |

- 5.1.0 dropped `browser/resources/attestor-browser.min.mjs` from the tarball (unpacked size
  2.64 MB → 1.02 MB) while still declaring `exports["./browser"]`, which
  [offscreen.js](src/offscreen/offscreen.js) imports. Resolution fails at build time. 5.1.1 restored it
  (2.58 MB unpacked, 1.55 MB bundle).
- 5.1.1 still failed OPRF proofs server-side with
  `oprf-raw cross-block markers incomplete: pending for packets N` on responses whose OPRF-marked region
  straddles TLS record boundaries — intermittently, so a provider could pass one run and fail the next.
  Patched in **5.1.3**. The error text appears in no client bundle: it is raised by the attestor
  service, reaching the offscreen document as `recv claim response {success: false}` _after_ the ZK
  proofs have already generated. Do not go back below 5.1.3.
- 5.0.6–5.0.8 still ship that bundle, but it no longer registers a ZK operator maker for `stwo` — the
  engine [config.js](src/utils/constants/config.js) `DEFAULT_ZK_ENGINE` selects. Nothing complains until
  proof time, when the offscreen document throws
  `Proof generation failed: No ZK operator maker for stwo` — _after_ the user has logged into the
  provider. `browser/resources/*.mjs` is a checked-in artifact built by a separate step upstream, which is
  how its contents drift between patch releases.

[attestor-zk-engine.test.js](src/utils/claim-creator/attestor-zk-engine.test.js) guards both: it asserts
the pinned version ships the bundle and that the bundle references `DEFAULT_ZK_ENGINE`. **Run `bun run test`
after any attestor bump** — that test turns both regressions from a runtime failure into a test failure.

**What a bump has to be checked against**, beyond that test — rechecked for 5.1.5:

- `exports["./browser"]` resolves and the bundle exports `createClaimOnAttestor`
  ([offscreen.js](src/offscreen/offscreen.js)); `exports["./external-rpc"]` exports
  `handleIncomingMessage` (the parity test's only route in).
- The ZK operator-maker registry in the **built** `build/offscreen/offscreen.bundle.js` — not just the
  package's copy — has a top-level `stwo` key. That is the object the
  `No ZK operator maker for ${engine}` throw reads.
- `CreateClaimOnAttestorOpts` still intersects `PrepareZKProofsBaseOpts`, which is what puts `zkEngine`
  at the top level of the object [claim-creator.js](src/utils/claim-creator/claim-creator.js) builds, and
  `updateParametersFromOprfData` still exists (the OPRF note above depends on its default).
- `HttpProviderParameters` / `HttpProviderSecretParameters` in `lib/types/providers.gen.d.ts` against the
  allowlists in [claim-shape.js](src/utils/claim-creator/claim-shape.js). Note
  `supportedProtocolVersions`, added in the 5.1 line, is nested under `additionalClientOptions`, not
  top-level — the allowlists still match exactly.

  5.1.1 also ships `lib/` as **ESM**. On 5.0.5 those were esbuild bundles doing named imports from the
  CommonJS `@reclaimprotocol/tls`, which Node's ESM loader refuses, so the package could not be loaded
  under Node and [attestor-parity.test.js](src/utils/claim-creator/attestor-parity.test.js) — the
  differential check of the vendored extraction code against the real attestor — **skipped**. It now runs
  and passes, which is the strongest available evidence that the vendored copies are still in sync. The
  suite went 148 tests/1 skipped → 159 tests/0 skipped on this bump alone. The skip path is kept in case a
  future pin regresses to the CJS shape.

### Messaging

Three separate action vocabularies, all in [src/utils/constants/interfaces.js](src/utils/constants/interfaces.js):

- `RECLAIM_SDK_ACTIONS` (`RECLAIM_*`) — web page ↔ content script over `window.postMessage`.
- `MESSAGE_ACTIONS` — content ↔ background ↔ offscreen over `chrome.runtime` / `chrome.tabs`.
- `MESSAGE_SOURCES` — every internal message carries `{action, source, target, data}`, and
  [messageRouter.js](src/background/messageRouter.js) validates `source`/`target` plus
  `ctx.managedTabs.has(sender.tab.id)` before acting. Adding a handler means adding a case _and_
  the matching guard; unmanaged tabs must be rejected.
- **A page never chooses what a claim requests.** `FILTERED_REQUEST_FOUND` carries only
  `{requestHash, request}`. [claimRequest.js](src/background/claimRequest.js) takes the
  criteria from the pinned recipe entry with that hash, and the page cannot supply parameter
  values. Recipes need not store a `requestHash`, so `withRequestKeys`
  keys each entry when the provider is fetched: its stored hash if unique, else its position. The
  request must still match that entry, and its host must be in the signed `hostWhitelist`, before
  any cookie is read. Page-reported `Cookie`/`Origin`/`Referer` headers and any
  `cookieStr`/`pageOrigin`/`referer` are dropped. The sender must be the live
  verification tab: its top frame, or a subframe whose origin host is signed (Fairscale's POST
  only fires inside a `fairscale.xyz` frame).
- **Log config and relayed logs are extension-internal.** `UPDATE_LOG_CONFIG` is accepted only
  from this extension's own pages, and a web page cannot set the log level at all.
  `LOG_MESSAGE` is accepted from extension pages and from the content script of the provider
  or caller tab.

### No provider code runs in the page

The extension runs no provider-authored code and exposes no page API. A recipe or registry response
carrying `customInjection` or `customInjectionSha256` is refused before any tab opens
(`fetchProviderData`), and the registry refuses to save or serve one.

What a page needs beyond its own traffic is declarative. A recipe's `requestChain` names a ready URL
and the response fields that fill the next request's template variables. Content sends
`INJECT_VIA_SCRIPTING {op: "RUN_REQUEST_CHAIN"}`; `runBoundRequestChain` in
[injectionManager.js](src/background/injectionManager.js) checks the managed tab's top frame, document,
login-URL origin and that every chain URL's host is signed, then runs one fixed fetch function once per
document in the MAIN world. The page-world interceptor captures those fetches like any page request.

A provider request that is the page's own document loads before the interceptor exists. Content therefore
also sends `{op: "REPLAY_BOUND_DOCUMENT"}`, once provider data arrives and on each URL change.
`runBoundReplay` in the same module re-requests the tab's URL, read from `chrome.tabs.get` and never from
the message, as one credentialed same-origin XHR in that document. It does so only if the recipe declares
that exact URL as a plain GET, and its host is in the signed attestor whitelist. The query must match
exactly. A template variable stays within one path segment or one query value. The same round also
requests every other plain GET of the pinned recipe whose URL is fixed (no `{{…}}` variable, not `REGEX`)
and on the document's origin, so a connected recipe proves all its requests from one signed-in page with
no navigation. Each document and URL is replayed at most once, with at most 3 replays per session for
each plain GET the recipe declares. Only `disableRequestReplay: true` turns it off.

**A function passed to `chrome.scripting.executeScript` runs in the page without the bundle's Babel
helpers.** The build targets ES5, so spread, `for...of` and destructuring there compile to helper calls
that throw in the page, and the function's own `catch` hides it. Source tests run it natively and pass;
[build-checks/](build-checks/) (`bun run test:build`, in CI after the build) runs the built ones.

### Provider host access

A consumer that grants provider sites as optional host permissions imports
`@umia/zktls-extension-sdk/provider-access` ([providerAccess.js](src/background/providerAccess.js),
dependency-free source): `providerContentScript()` builds the dynamic registration (every frame, at
`document_start`) and `providerRequestUrls()` lists the provider's request URLs, which need a grant
alongside the login site. The router pins the verification popup to frame 0, and the popup sets its own
top-of-stack `z-index`.

The popup is the Umia widget from [src/ui/](src/ui/), rendered in a closed shadow root so provider-page
CSS can't reach it. `reduceWidget` folds each popup handler call into a view, and `webpack.config.js`
concatenates `tokens.css`, `base.css` and `widget.css` into the popup stylesheet the content script
fetches. Fonts ship in `build/fonts/` and are registered on the document (Chrome ignores `@font-face` in
a shadow root). `theme.js` follows the Hub's light/dark/system choice, which the extension mirrors
into `chrome.storage.local` as `umiaTheme`; `tokens.css` holds the light values from Figma and the
dark values from the Hub's `.dark` theme. `web/extension` imports the same kit for its grant page
through the `./ui/*` export.

### Offscreen document

`installOffscreenReadyListener()` runs at background init; `ensureOffscreenDocument()` creates the
document on demand and waits for `OFFSCREEN_DOCUMENT_READY`. Proof generation is only reachable through
`GENERATE_PROOF` / `GENERATE_PROOF_RESPONSE` messages — the offscreen document exists because
attestor-core needs WASM, real WebSockets, and `crypto.getRandomValues`, none of which are usable
directly from an MV3 service worker.

A bound session's attestor client lives in
[session-attestor.js](src/offscreen/session-attestor.js): one fresh client and socket per
session/auth identity, closed on replacement, cancellation, completion, `pagehide` and at
`boundSessionDeadline()` (the earlier of the signed auth and session expiries). A deadline
close reports `SESSION_EXPIRED`, any other close `CANCELLED`, so the code does not depend on which of
this and the background's expiry timer fires first; both use [at-deadline.js](src/utils/at-deadline.js).
Offscreen drops results that arrive after a close; the background's
[proof-generator.js](src/utils/proof-generator/proof-generator.js) accepts a reply only for its own
`transportRequestId`, session ID and extension sender. A proof timeout or a socket that never opened
reports `ATTESTOR_UNREACHABLE`. A rejection carrying one of the patched attestor's finite reasons
(`data.reason`, thrown or inside the claim response's `error`) reports the code
`ZKTLS_ATTESTOR_REJECTION_CODES` in `@umia/zktls-config/self-host` maps it to, by exact table membership.
Without a known reason, the attestor's `ERROR_AUTHENTICATION_FAILED` code reports `ATTESTOR_AUTH_FAILED`
and any other attestor failure reports `PROOF_GENERATION_FAILED`.
Cancellation also comes from the initiating document's content script, which sends
`CANCEL_VERIFICATION` on `pagehide`: proofs can only be delivered to that document.

ZK chunk proofs run in workers. `getOperators` gives each claim its own pool from
[pooled-zk-operators.js](src/utils/zk/pooled-zk-operators.js) — `stwo-worker.js` (module worker)
or `snarkjs-worker.js` (classic worker, since ffjavascript's blob workers break the extension
CSP) — sized by `ZK_WORKER_POOL_SIZE` (build-time, 0–4, default `min(hardwareConcurrency, 4)`; 0
proves in-thread). The pool closes when its claim ends, so switching engines never keeps two
resident. A crashed worker retries its chunk once; a timeout fails the claim. Stwo proofs of 64 KiB
or more are deflated behind a `UMIA_STWO_ZLIB_V1` header when smaller
([stwo-proof-compression.js](src/utils/zk/stwo-proof-compression.js)); the patched attestor
inflates them. `STWO_PROOF_COMPRESSION=0` at build time turns that off.

## Build output and bundle-format constraints

Three webpack configs in [webpack.config.js](webpack.config.js), all writing into a single `build/`
(`clean: false` after the first, so build order matters):

1. `extension-classic` — content script as **UMD** (`ReclaimContent`), interceptor + offscreen as
   classic scripts. The content script must not be ESM: an MV3 `content_scripts` entry loading an
   ES module fails with `Unexpected token 'export'`.
2. `background-esm-mv3` — `background/background.bundle.js` + `ReclaimExtensionSDK.bundle.js` as ES
   modules (`output.module`, `experiments.outputModule`).
3. `background-commonjs-mv2` — the same two entries as `*-mv2.bundle.js` in CommonJS for Firefox/MV2.

attestor-core drags in Node built-ins, so `commonResolve` aliases `koffi`/`re2`/`snarkjs` to `false`,
maps `worker_threads`/`jsdom`/`module` to stubs in [src/utils/mocks/](src/utils/mocks/), and points `ws`
at [websocket-polyfill.js](src/utils/websocket-polyfill.js). The same exclusions are duplicated in
`package.json`'s `browser` field — a new native-dep failure usually needs entries in both places.
`ignoreWarnings` in the first config deliberately silences the resulting resolution noise.

`__SDK_VERSION__` is a DefinePlugin global injected from `package.json`; the SDK reports it as
`ext-<version>` in `sdkVersion`.

[stable-import-meta-url.js](webpack-build-utils/stable-import-meta-url.js) replaces webpack's absolute
`import.meta.url` with the module's path from its package root, so builds are byte-identical across
checkout paths. Only attestor-core's Node-only local file fetch reads it.

## Logging

**Logs never leave the device.** The hosted `logDump` endpoint, the queue, its `chrome.storage.session`
mirror, the flush schedule and the per-install device ID were removed for the self-host fork.
[LoggingHub.js](src/utils/logger/LoggingHub.js) is now a level gate plus redaction in front of the
console; [logging-hub.test.js](src/utils/logger/logging-hub.test.js) `"logs never leave the device"`
fails if storage, timers or the network come back. Session telemetry is separate and finite:
[telemetry.js](src/background/telemetry.js) sends only fixed event and stage tokens to the bound
backend's `/api/sdk/telemetry`; the consumer's permission gate reports `permission_requested` and
`permission_granted` through `ctx.reportTelemetry`. `proof_started` is not one of them, because offscreen's
`PROOF_GENERATION_STARTED` status update already records it.

Background writes directly to the singleton `loggingHub`; content and offscreen use
`createRemoteLogger("content" | "offscreen")`, which forwards `LOG_MESSAGE` to the hub so one console
(the service worker's) shows the whole flow, labelled by originating context.

```javascript
// background
import { loggingHub } from "../utils/logger/LoggingHub";
loggingHub.info(message, "background.verification"); // also .debug / .warn / .error

// content or offscreen
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
const logger = createRemoteLogger("content");
```

MAIN-world scripts (`src/interceptor/`) have no `chrome.runtime`, so they use
[log-bridge.js](src/interceptor/log-bridge.js) `createPageLogger(context, category)`, which
`window.postMessage`s `RECLAIM_LOG`; `content.js` relays it via `logger.relay()` with the _originating_
context preserved. Never add a bare `console.log` in the interceptor — it would bypass the config gate
and redaction.

The second argument is a dotted category (`background.claim`, `background.csp`, …) — reuse an existing
one where it fits.

- **One threshold, and it decides redaction.** `config.logLevel` decides what is printed and in what
  form. `INFO` (the default) prints a redacted _copy_ of every payload; `FINE` prints it raw
  except credentials (`redactCredentials`): cookies, keys, tokens and signatures are blanked at
  every level.
  `config.consoleEnabled` (default off) decides whether anything is printed at all. The content-script
  console is the **provider tab's** console, so the default must never show the user's own data there.
- **Levels use the platform's spelling: `SEVERE` → `WARNING` → `INFO` → `FINE`.**
  `normalizeLogLevel()` in [logger/constants.js](src/utils/logger/constants.js) still resolves the old
  `ERROR`/`WARN`/`DEBUG` names (and `CONFIG`, `FINER`, `FINEST`) so a persisted consumer config keeps
  working. `loggingHub.debug()` emits `FINE`, `.error()` emits `SEVERE`; `.fine()` is an alias.
- **Pass structured data as the payload, never pre-stringified.** `info("x: " + JSON.stringify(obj))`
  prints whatever `obj` holds, because a message string is never redacted. `redact.js` matches
  sensitive keys by substring (`signature`, `secret`, `token`, …) and blanks the _values_ of
  `parameters`/`paramValues` while keeping their key names. `OPAQUE_KEYS` (`claimData`, `context`,
  `extractedParameters`, `injectionResult`) are blanked whole; `USER_DATA_KEYS` match whatever the
  value's type, since the attestor returns several of them as JSON strings.
- **Response content never goes in a message string.** `RedactionResolveError` carries the matched
  element as `error.element`, logged through the payload, and `RESPONSE_CONTENT_KEYS` in
  [redact.js](src/utils/logger/redact.js) replaces such strings with `<redacted:N chars>` at `INFO`.
  Extraction success lines carry the selector and the value's **length**; the value rides the payload
  under `extractedParameters`.

Log level and console output come from `chrome.storage.local` under `LOG_CONFIG_STORAGE_KEY` and can be
set from an extension page via `reclaimExtensionSDK.setLogConfig()` or `init(..., { logConfig })`;
from a web page both are refused. For local work, call
`setLogConfig({ consoleEnabled: true, logLevel: "FINE" })` from an extension page. `content.js` pushes the config into the MAIN
world as `RECLAIM_LOG_CONFIG`, since the page world cannot read `chrome.storage` itself.
[log-bridge.js](src/interceptor/log-bridge.js) therefore keeps its own copy of the defaults — **keep the
two in sync**; it cannot import them, being dependency-free by design.

### `eventType` — the cross-SDK taxonomy

`EVENT_TYPES` in [logger/constants.js](src/utils/logger/constants.js) is reconciled against the InApp
SDK's `LogEventType` (`reclaim-inapp-sdk/lib/src/logging/event_type.dart`). **If a name exists upstream,
spell it the same way** — the point is that one Grafana query spans both SDKs. Before adding a name, look
for one that already means the same thing; the file's header records the renames already made, and
[logging-hub.test.js](src/utils/logger/logging-hub.test.js) fails if a retired extension-local name
(`CLAIM_CREATION_SUCCESS`, `VERIFICATION_FLOW_FAILED`, …) comes back.

Pass it alongside the category, both being separate axes — `eventType` answers "where in the flow",
`type` answers "which module":

```javascript
loggingHub.info("[BACKGROUND] Fetched provider data …", "background.provider", {
  eventType: EVENT_TYPES.FETCHED_PROVIDERS,
});
```

`EVENT_TYPES` reaches the background modules through `ctx` (they take `ctx` first and import nothing —
see the shared-context pattern above); `proofQueue` destructures it. The hub accepts it but does not print
it now that logs stay local; the names stay aligned with upstream. MAIN-world callers use the bridge's
`debug.event(EVENT_TYPES.X, …)`, kept separate from the level methods so the variadic console-style
signature stays intact.

`failSession(ctx, reason, requestHash, eventType)` maps `reason` through `failureCode` onto the closed
`ZKTLS_ERROR_CODES` enum, and only that code reaches the page, popup or backend; pass a code, or
`failureCode(error, fallback)` to keep a code an error already carries. Never pass prose: provider, page
and request text must not leave the background. It takes an optional event type, defaulting to
`RECLAIM_EXCEPTION`. The session timer passes `CLAIM_CREATION_TIMED_OUT_EXCEPTION` — and note it can only
fire _after_ the first intercepted request, which is why
`RECLAIM_VERIFICATION_NO_ACTIVITY_DETECTED_EXCEPTION` is emitted from the **content script's** no-match
timer instead, and only when nothing was ever intercepted. See "The gate reports which check rejected a
request" above.

## `reclaim-api-client`

Every request to the session's backend carries `reclaim-api-client: <client source>`, matching what the
InApp SDK and Verifier app send — `fetchProviderData`, `updateSessionStatus`, `postTelemetry`,
`submitBoundProofs` ([fetch-calls.js](src/utils/fetch-calls.js)) and `_initSession`
([ReclaimExtensionSDK.js](src/ReclaimExtensionSDK.js)). The backend is the Umia API's compat routes
(`services/api/src/routes/zktls-compat.ts`), whose CORS policy allows that header.

The extension contributes **no device information**: request bodies carry no `deviceId`/`deviceType`,
and it emits no `appLogs`. The API records `USER_STARTED_VERIFICATION` as a session event from
`updateSessionStatus`; there is no extension equivalent of InApp's `FETCHED_PROVIDERS`.

## Docs

[readme.md](readme.md) is the consumer-facing integration guide (assets, manifest, permissions,
troubleshooting) for how Umia uses the fork. The per-module READMEs
([background](src/background/README.md), [content](src/content/README.md),
[offscreen](src/offscreen/README.md), [logger](src/utils/logger/README.md)) are short module maps,
rewritten for the fork. Update them with the code they describe.
