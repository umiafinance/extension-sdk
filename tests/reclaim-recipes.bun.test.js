import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readReclaimBenchFixture } from "../../providers/src/providers/fixtures/reclaim-bench.ts";
import { requestHashes } from "../../providers/src/providers/hash.ts";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { validateProviderDraft } from "../../providers/src/providers/validate.ts";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import {
  extractParamsFromResponse,
  extractParamsFromUrl,
  separateParams,
} from "../src/utils/claim-creator/params-extractor.js";

const KEYS = ["luma-direct", "luma-metadao", "echo"];
const RECIPES = { echo: "echo-participant/echo.json" };

function raw(key) {
  const path = RECIPES[key] ?? `reclaim-2827/${key}.json`;
  return readFileSync(new URL(`../../providers/recipes/${path}`, import.meta.url), "utf8");
}

function recipe(key) {
  return prepareProviderJson(raw(key));
}

function extract(key, response, requestParams = {}) {
  const request = recipe(key).candidate.providerConfigs[0].requestData[0];
  return extractParamsFromResponse(
    response,
    request.responseMatches,
    request.responseRedactions,
    requestParams,
  );
}

describe("local recipe candidates (synthetic extraction, no live proof evidence)", () => {
  for (const key of KEYS) {
    test(`${key} passes registry preparation with a new claim hash and still needs evidence`, () => {
      const prepared = recipe(key);
      const old = readReclaimBenchFixture(key);
      expect(prepared.claimHashes).not.toEqual(requestHashes(old.providerConfigs).claimHashes);
      const lint = validateProviderDraft(prepared.candidate);
      expect(lint.errors).toEqual([]);
      expect(lint.warnings).toEqual([]);
      expect(lint.missingEvidence.map(({ code }) => code)).toEqual([
        "PROOF_CONFORMANCE_REQUIRED",
        "IDENTITY_BINDING_REQUIRED",
        "PRIVACY_REVIEW_REQUIRED",
      ]);
    });
  }

  test("Google stays blocked: the registry refuses its selector-scoped email capture", () => {
    const redaction = JSON.parse(raw("google")).providerConfigs[0].requestData[0]
      .responseRedactions[0];
    expect(redaction).toMatchObject({ jsonPath: "$[2]", hash: "oprf-raw" });
    expect(() => recipe("google")).toThrow("IDENTITY_SHAPE_MISMATCH");
  });

  for (const key of ["luma-direct", "luma-metadao"]) {
    test(`${key} keeps query data secret and rejects a guest that is not approved`, () => {
      const request = recipe(key).candidate.providerConfigs[0].requestData[0];
      const url = request.url.replace("{{URL_PARAM_GRD_SECRET}}", "?ref=private-ref");
      const params = extract(
        key,
        JSON.stringify({ approval_status: "approved", proxy_key: "guest_demo_1" }),
        extractParamsFromUrl(request.url, url),
      );
      expect(separateParams(params)).toEqual({
        publicParams: { lumaguest: "guest_demo_1" },
        secretParams: { URL_PARAM_GRD_SECRET: "?ref=private-ref" },
      });
      expect(recipe(key).extractionShape).toBe("lumaguest:oprf-raw");
      for (const status of ["pending_approval", "declined"]) {
        expect(() =>
          extract(key, JSON.stringify({ approval_status: status, proxy_key: "guest_demo_1" })),
        ).toThrow();
      }
      expect(() => extract(key, JSON.stringify({ guest_data: null }))).toThrow();
    });
  }

  test("different Luma events do not share a namespace for their per-guest keys", () => {
    expect(recipe("luma-direct").candidate.identityProvider).not.toBe(
      recipe("luma-metadao").candidate.identityProvider,
    );
  });

  test("Echo keeps every UUID group secret within the attestor run limit", () => {
    const request = recipe("echo").candidate.providerConfigs[0].requestData[0];
    const url = "https://app.echo.xyz/portfolio/12345678-1234-4567-8901-123456789abc/current";
    const response = JSON.stringify(
      JSON.stringify({ InvestedAmountUSDC: "100000000", EmailAddress: "investor@example.test" }),
    );
    expect(
      describeRequestMatch(
        {
          url: "https://app.echo.xyz/portfolio/00000000-0000-4000-8000-000000000001/current",
          method: "GET",
          responseText: response,
        },
        request,
      ),
    ).toEqual({ matched: true, stage: "matched" });
    expect(separateParams(extract("echo", response, extractParamsFromUrl(request.url, url)))).toEqual({
      publicParams: { echouser: "investor@example.test" },
      secretParams: {
        URL_PARAM_1_SECRET: "12345678",
        URL_PARAM_2_SECRET: "1234",
        URL_PARAM_3_SECRET: "4567",
        URL_PARAM_4_SECRET: "8901",
        URL_PARAM_5_SECRET: "123456789abc",
      },
    });
    // The key-update mode hides the entire request path; explicit ZK mode must
    // preserve the literal separators for the attestor's contiguous-run guard.
    expect(request.writeRedactionMode).toBe("zk");
    const privatePath = new URL(
      request.url.replace(/\{\{[^}]+\}\}/g, (placeholder) => {
        const key = placeholder.slice(2, -2);
        const value = extractParamsFromUrl(request.url, url)[key];
        expect(value.length).toBeGreaterThan(0);
        return "*".repeat(value.length);
      }),
    ).pathname;
    const hiddenRuns = privatePath.match(/\*+/g);
    expect(hiddenRuns.map((run) => run.length)).toEqual([8, 4, 4, 4, 12]);
    expect(Math.max(...hiddenRuns.map((run) => run.length))).toBeLessThanOrEqual(12);
    expect(recipe("echo").extractionShape).toBe("echouser:oprf-raw");
    const investedRule = request.responseMatches[0];
    expect(new RegExp(investedRule.value).test(response)).toBe(true);
    expect(new RegExp(investedRule.value).test(response.replace("100000000", "0"))).toBe(false);
  });
});
