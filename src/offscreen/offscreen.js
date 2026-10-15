// Import necessary utilities and interfaces
import "../utils/polyfills";
import { MESSAGE_ACTIONS, MESSAGE_SOURCES, RECLAIM_SESSION_STATUS } from "../utils/constants";
import { failureCode } from "../utils/constants/interfaces";
import {
  ZKTLS_ATTESTOR_REJECTION_CODES,
  zktlsAttestorRejectionReason,
} from "@umia/types/zktls-self-host";
import { createClaimOnAttestor, makeDefaultZkOperator } from "@reclaimprotocol/attestor-core/browser";
import { WebSocket } from "../utils/offscreen-websocket";
import { updateSessionStatus } from "../utils/fetch-calls";
import { createRemoteLogger } from "../utils/logger/RemoteLogger";
import { EVENT_TYPES } from "../utils/logger/constants";
import { PROOF_GENERATION_TIMEOUT_MS, ZK_WORKER_POOL_SIZE } from "../utils/constants/config";
import {
  makePooledSnarkjsOperators,
  makePooledStwoOperators,
} from "../utils/zk/pooled-zk-operators";
import { takeOffscreenSession } from "../utils/session-transport";
import { BoundAttestorSessions } from "./session-attestor";

const logger = createRemoteLogger("offscreen");

// The attestor names a rejection by `data.reason`, or by code alone before #2833; its
// message text is not part of the contract.
function attestorFailureCode(error) {
  const reason = zktlsAttestorRejectionReason(error);
  if (reason) return ZKTLS_ATTESTOR_REJECTION_CODES[reason];
  if (error?.code === "ERROR_AUTHENTICATION_FAILED") return "ATTESTOR_AUTH_FAILED";
  return undefined;
}

function attestorFailure(error, unreachable) {
  if (unreachable) return new Error("ATTESTOR_UNREACHABLE");
  const code = attestorFailureCode(error);
  return code ? new Error(code) : error;
}

// A closed client reports why it closed; the session status already records it.
const TERMINAL_CODES = new Set(["CANCELLED", "SESSION_EXPIRED"]);

// Ensure WebAssembly is available
if (typeof WebAssembly === "undefined") {
  logger.error(
    "[OFFSCREEN] WebAssembly is not available in this browser context",
    "offscreen.init",
    { eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_NOT_READY_EXCEPTION },
  );
}

// Set WASM path to the extension's public path
if (typeof global !== "undefined") {
  global.WASM_PATH = chrome.runtime.getURL("");
}

// Ensure WebSocket is globally available in the offscreen context
window.WebSocket = WebSocket;

class OffscreenProofGenerator {
  constructor() {
    this.boundSessions = new BoundAttestorSessions({ makeWebSocket: (url) => new WebSocket(url) });
    this.pendingBySession = new Map();
    this.activeOperators = null;
    this.init();
    window.addEventListener?.("pagehide", () => {
      for (const sessionId of this.pendingBySession.keys()) this.closeSession(sessionId);
      this.boundSessions.closeAll();
      this.activeOperators?.close();
    });
  }

  getOperators(engine, metrics) {
    // A claim owns its workers. Replacing or cancelling it cannot leave old
    // proofs queued ahead of the next claim or keep both engines resident.
    this.activeOperators?.close();
    this.activeOperators = null;
    if (engine !== "stwo" && engine !== "snarkjs") return undefined;
    const makePooled = engine === "stwo" ? makePooledStwoOperators : makePooledSnarkjsOperators;
    const operators = makePooled(ZK_WORKER_POOL_SIZE, {
      makeOperator: (algorithm) => makeDefaultZkOperator(algorithm, engine),
      onProve: ({ algorithm, poolSize, proveMs, workerProveMs, startedAt, endedAt, fallback }) => {
        if (metrics.active) {
          metrics.chunks++;
          metrics.totalProveMs += proveMs;
          metrics.totalWorkerMs += workerProveMs || 0;
          metrics.proveStart = Math.min(metrics.proveStart, startedAt);
          metrics.proveEnd = Math.max(metrics.proveEnd, endedAt);
        }
        logger.info(
          `[${engine.toUpperCase()}] chunk algorithm=${algorithm} pool=${poolSize} elapsedMs=${proveMs.toFixed(1)} workerMs=${workerProveMs?.toFixed(1) ?? "inline"} fallback=${fallback}`,
          "offscreen.proof",
        );
      },
    });
    this.activeOperators = operators;
    return operators;
  }

  init() {
    logger.info("[OFFSCREEN] Offscreen ready", "offscreen.init", {
      eventType: EVENT_TYPES.OFFSCREEN_DOCUMENT_READY,
    });
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    this.sendReadySignal();
  }

  sendReadySignal() {
    chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.OFFSCREEN_DOCUMENT_READY,
      source: MESSAGE_SOURCES.OFFSCREEN,
      target: MESSAGE_SOURCES.BACKGROUND,
    });
  }

  handleMessage(message, sender, sendResponse) {
    const { action, source, target, data, sessionId, providerId } = message;

    if (target !== MESSAGE_SOURCES.OFFSCREEN) return;
    if (
      (action === MESSAGE_ACTIONS.GENERATE_PROOF ||
        action === MESSAGE_ACTIONS.CLOSE_BOUND_SESSION ||
        action === MESSAGE_ACTIONS.GET_PRIVATE_KEY) &&
      (source !== MESSAGE_SOURCES.BACKGROUND || sender?.id !== chrome.runtime.id || sender?.tab)
    ) {
      sendResponse({ success: false, error: "Untrusted offscreen sender" });
      return;
    }

    switch (action) {
      case MESSAGE_ACTIONS.PING_OFFSCREEN:
        this.sendReadySignal();
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.GENERATE_PROOF:
        if (typeof message.transportRequestId !== "string" || !message.transportRequestId) {
          sendResponse({ success: false, error: "Invalid request" });
          break;
        }
        (async () => {
          const responseSessionId = data?.session?.sessionId;
          let request;
          try {
            logger.info("[OFFSCREEN] Generating proof", "offscreen.proof", {
              eventType: EVENT_TYPES.PROOF_GENERATION_STARTED,
            });

            const { session, claim } = takeOffscreenSession(data);
            // The background queue is serial. A repeated ID replaces its old
            // request, so a late resolution cannot complete the new session.
            this.closeSession(session.sessionId);
            request = { cancelled: false };
            this.pendingBySession.set(session.sessionId, request);
            const proof = await this.generateProof(session, claim, request);
            if (request.cancelled) throw new Error("CANCELLED");

            // Edge case: proof object contains an error
            const embeddedErr =
              proof?.error?.message || (typeof proof?.error === "string" ? proof.error : null);

            if (embeddedErr) {
              logger.error("[OFFSCREEN] Proof contains embedded error", "offscreen.proof", {
                eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION,
              });
              chrome.runtime.sendMessage({
                action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
                source: MESSAGE_SOURCES.OFFSCREEN,
                target: MESSAGE_SOURCES.BACKGROUND,
                success: false,
                error: attestorFailureCode(proof.error) ?? "PROOF_GENERATION_FAILED",
                sessionId: responseSessionId,
                transportRequestId: message.transportRequestId,
              });
              return;
            }

            // Reported here, not on attestor resolution: the proof is only known
            // good once the embedded-error check above has passed.
            try {
              await updateSessionStatus(session, RECLAIM_SESSION_STATUS.PROOF_GENERATION_SUCCESS);
            } catch (e) {
              logger.error(
                "[OFFSCREEN] Error updating status to PROOF_GENERATION_SUCCESS: " + e?.message,
                "offscreen.proof",
              );
            }
            if (request.cancelled) throw new Error("CANCELLED");

            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: true,
              proof: proof,
              sessionId: responseSessionId,
              transportRequestId: message.transportRequestId,
            });
          } catch (error) {
            logger.error("[OFFSCREEN] Error generating proof", "offscreen.proof", {
              eventType: EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION,
            });
            chrome.runtime.sendMessage({
              action: MESSAGE_ACTIONS.GENERATE_PROOF_RESPONSE,
              source: MESSAGE_SOURCES.OFFSCREEN,
              target: MESSAGE_SOURCES.BACKGROUND,
              success: false,
              error: failureCode(error, "PROOF_GENERATION_FAILED"),
              sessionId: responseSessionId,
              transportRequestId: message.transportRequestId,
            });
          } finally {
            if (this.pendingBySession.get(responseSessionId) === request) {
              this.pendingBySession.delete(responseSessionId);
            }
          }
        })();

        sendResponse({ received: true });
        break;

      case MESSAGE_ACTIONS.CLOSE_BOUND_SESSION:
        if (typeof sessionId !== "string" || !sessionId) {
          sendResponse({ success: false, error: "Invalid session ID" });
          break;
        }
        this.closeSession(sessionId);
        sendResponse({ success: true });
        break;

      case MESSAGE_ACTIONS.GET_PRIVATE_KEY:
        try {
          const randomBytes = window.crypto.getRandomValues(new Uint8Array(32));
          const privateKey =
            "0x" +
            Array.from(randomBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");

          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: true,
            privateKey: privateKey,
          });
          logger.info("[OFFSCREEN] Private key generated", "offscreen.key");
          sendResponse({ success: true, received: true });
        } catch (error) {
          chrome.runtime.sendMessage({
            action: MESSAGE_ACTIONS.GET_PRIVATE_KEY_RESPONSE,
            source: MESSAGE_SOURCES.OFFSCREEN,
            target: source,
            success: false,
            error: error.message || "Unknown error generating private key",
          });
          logger.error(
            "[OFFSCREEN] Error generating private key: " + error.message,
            "offscreen.key",
          );
          sendResponse({ success: false, error: error.message });
        }
        break;

      default:
        logger.error("[OFFSCREEN] Unknown action: " + action, "offscreen.message");
        sendResponse({ success: false, error: "Unknown action" });
    }

    return true;
  }

  closeSession(sessionId) {
    const request = this.pendingBySession.get(sessionId);
    if (request) request.cancelled = true;
    this.boundSessions.closeSession(sessionId);
  }

  async generateProof(session, claim, request) {
    const handle = this.boundSessions.open(session);

    // Declared outside the try so the catch can read it — it was set here and
    // never read anywhere, which is why nothing caught the scoping.
    let timeoutOccurred = false;
    let timeoutId;
    let claimMetrics;
    let zkOperators;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutOccurred = true;
          reject(
            new Error(
              "Proof generation timed out after " + PROOF_GENERATION_TIMEOUT_MS / 1000 + " seconds",
            ),
          );
        }, PROOF_GENERATION_TIMEOUT_MS);
      });

      logger.info(
        "[OFFSCREEN] Updating session status to PROOF_GENERATION_STARTED",
        "offscreen.proof",
      );
      await Promise.race([
        updateSessionStatus(session, RECLAIM_SESSION_STATUS.PROOF_GENERATION_STARTED),
        timeoutPromise,
        handle.cancelled,
      ]);
      handle.assertLive();
      if (request.cancelled) throw new Error("CANCELLED");

      // Claims can include secrets; never log the offscreen transport payload.
      logger.debug("[OFFSCREEN] Claim ready for attestor", "offscreen.proof");

      // NOT awaited here on purpose. Awaiting first and only then racing the
      // timeout meant the race ran against an already-settled value, so
      // PROOF_GENERATION_TIMEOUT_MS could never interrupt a hung attestor call
      // — and the "promise created" line was logged after the call had already
      // finished, landing in the same millisecond as the result and making the
      // logs claim the call started 16s later than it did.
      claimMetrics = {
        active: true,
        engine: claim.zkEngine,
        start: performance.now(),
        chunks: 0,
        totalProveMs: 0,
        totalWorkerMs: 0,
        proveStart: Infinity,
        proveEnd: 0,
      };
      zkOperators = this.getOperators(claim.zkEngine, claimMetrics);
      const logPrefix = `[${(claim.zkEngine || "ZK").toUpperCase()}]`;
      const attestorPromise = createClaimOnAttestor({
        ...claim,
        client: handle.client,
        maxRetries: 1,
        zkOperators,
        onStep: (step) => {
          const elapsedMs = performance.now() - claimMetrics.start;
          logger.info(`${logPrefix} step=${step.name} t=${elapsedMs.toFixed(0)}ms`, "offscreen.proof");
          if (step.name === "waiting-for-verification") {
            logger.info(`${logPrefix} proofs-finished t=${elapsedMs.toFixed(0)}ms`, "offscreen.proof");
          }
        },
      });

      logger.info("[OFFSCREEN] Attestor call started", "offscreen.proof");

      const result = await Promise.race([attestorPromise, timeoutPromise, handle.cancelled]);
      logger.info(
        `${logPrefix} claim-rpc-returned t=${(performance.now() - claimMetrics.start).toFixed(0)}ms`,
        "offscreen.proof",
      );
      handle.assertLive();
      if (request.cancelled) throw new Error("CANCELLED");

      result.publicData = typeof claim.publicData === "string" ? claim.publicData : null;

      logger.info("[OFFSCREEN] Attestor promise result received", "offscreen.proof");

      // PROOF_GENERATION_SUCCESS is deliberately NOT reported here. The attestor
      // can resolve with an error carried inside the result object, which only
      // the caller checks. Reporting success on resolution meant a failed
      // session recorded PROOF_GENERATION_SUCCESS and then
      // PROOF_GENERATION_FAILED, so analytics claimed both outcomes for the same
      // session. The caller now reports it once the proof is validated.
      return result;
    } catch (error) {
      // Stop queued and running proofs before a failed status update can delay cleanup.
      if (claimMetrics) claimMetrics.active = false;
      zkOperators?.close();
      // `timeoutOccurred` distinguishes "the attestor took too long" from "the
      // attestor threw", which are different problems with the same message
      // prefix. This is the timeout that actually fires — the background's
      // PROOF_RESPONSE_TIMEOUT_MS is deliberately longer, so it only sees a
      // document that never answered.
      const timedOut = timeoutOccurred;
      // Only the attestor's fixed rejection enum is safe to include in a log
      // line; the raw error may contain claim or response bytes.
      const rejection = zktlsAttestorRejectionReason(error);
      logger.error(`[OFFSCREEN] Error generating proof (${rejection ?? "unknown"})`, "offscreen.proof", {
        eventType: timedOut
          ? EVENT_TYPES.CLAIM_CREATION_TIMED_OUT_EXCEPTION
          : EVENT_TYPES.PROOF_GENERATION_FAILED_EXCEPTION,
      });
      const failure = attestorFailure(error, timedOut || handle.dialFailed());
      if (!TERMINAL_CODES.has(failure?.message) && !request.cancelled) {
        try {
          await updateSessionStatus(
            session,
            RECLAIM_SESSION_STATUS.PROOF_GENERATION_FAILED,
            failureCode(failure, "PROOF_GENERATION_FAILED"),
          );
        } catch {
          // An expired route cannot send a bearer; preserve the proof error.
        }
      }
      throw failure;
    } finally {
      if (claimMetrics) {
        claimMetrics.active = false;
        if (this.activeOperators === zkOperators) this.activeOperators = null;
        zkOperators?.close();
        logger.info(
          `[${(claimMetrics.engine || "ZK").toUpperCase()}] claim chunks=${claimMetrics.chunks} pool=${zkOperators?.poolSize ?? 0} proveWallMs=${claimMetrics.chunks ? (claimMetrics.proveEnd - claimMetrics.proveStart).toFixed(1) : 0} totalElapsedMs=${claimMetrics.totalProveMs.toFixed(1)} totalWorkerMs=${claimMetrics.totalWorkerMs.toFixed(1)} claimWallMs=${(performance.now() - claimMetrics.start).toFixed(1)}`,
          "offscreen.proof",
        );
      }
      clearTimeout(timeoutId);
      handle.close();
    }
  }
}

// Initialize the offscreen document
export const proofGenerator = new OffscreenProofGenerator();
