import type {
  ZktlsEndpointActivationRecord,
  ZktlsSessionConfig,
} from "@umia/types/zktls-self-host";

export interface InitOptions {
  extensionID?: string;
  endpointProfile?: string;
  providerVersion?: string;
  callbackUrl?: string;
}

export interface Proofs {
  [key: string]: unknown;
}

export type RequestEvents = "started" | "completed" | "error" | "progress";

export class ReclaimExtensionProofRequest {
  applicationId: string;
  providerId: string;
  sessionId: string;
  signature: string;
  timestamp: string;
  umia: ZktlsSessionConfig | null;
  getStatusUrl(): string;

  static fromJsonString(
    json: string | Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;
  static fromConfig(
    config: Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;

  setAppCallbackUrl(url: string, jsonProofResponse?: boolean): void;
  setRedirectUrl(url: string): void;
  setContext(address: string, message: string): void;
  setJsonContext(address: string, jsonObj: Record<string, unknown>): void;
  /** @deprecated Use setContext() instead */
  addContext(address: string | number, message: string): void;
  setParams(params: Record<string, unknown>): void;

  on(event: RequestEvents, cb: (payload?: unknown) => void): () => void;
  off(event: RequestEvents, cb: (payload?: unknown) => void): void;

  startVerification(): Promise<Proofs>;
  cancel(timeoutMs?: number): Promise<boolean | void>;
}

export class ReclaimExtensionSDK {
  initializeBackground(runtimeConfig?: {
    resolveSessionRoute: (request: {
      sender: chrome.runtime.MessageSender;
      sessionId: string;
      candidate: Pick<ZktlsSessionConfig, "backendUrl" | "attestorUrl" | "witness" | "network">;
    }) => Promise<ZktlsEndpointActivationRecord | null>;
  }): unknown;
  isExtensionInstalled(opts?: { extensionID?: string; timeout?: number }): Promise<boolean>;
  getVersion(): string;
  init(
    applicationId: string,
    appSecret: string,
    providerId: string,
    options?: InitOptions,
  ): Promise<ReclaimExtensionProofRequest>;

  // Convenience wrapper that forwards to ReclaimExtensionProofRequest.fromJsonString
  fromJsonString(
    json: string | Record<string, unknown>,
    options?: InitOptions,
  ): ReclaimExtensionProofRequest;
}

export const reclaimExtensionSDK: ReclaimExtensionSDK;
export const ZKTLS_BOUND_SESSION_ROUTE_VERSION: 1;
export default ReclaimExtensionSDK;
