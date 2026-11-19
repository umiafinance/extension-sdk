import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ZKTLS_PROVIDERS, githubGateSearchUrl } from "../../../types/src/zktls-providers.ts";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import { extractParamsFromResponse, separateParams } from "../src/utils/claim-creator/params-extractor.js";

const read = (name) => readFileSync(new URL(`../../providers/recipes/github-2026q3/${name}`, import.meta.url), "utf8");
const recipe = prepareProviderJson(read("outside-contributor.json"));
const request = recipe.candidate.providerConfigs[0].requestData[0];
const response = (count) => `<html><meta name="octolytics-actor-id" content="12345678" /><script>{"totalCount":${count}}</script></html>`;
const extract = (body) => extractParamsFromResponse(body, request.responseMatches, request.responseRedactions, {});

describe("outside-merges contributor (synthetic, not live proof evidence)", () => {
  test("pins the outside-repo merge search in one required request", () => {
    const pin = ZKTLS_PROVIDERS["github-outside-contributor"];
    expect(recipe.candidate.id).toBe(pin.id);
    expect(recipe.candidate.providerConfigs).toHaveLength(1);
    expect(recipe.candidate.providerConfigs[0].requestData).toHaveLength(1);
    expect(recipe.claimHashes).toHaveLength(1);
    expect(recipe.candidate.providerConfigs[0].loginUrl).toBe(request.url);
    expect(request.url).toBe(githubGateSearchUrl(pin.github));
    expect(new URL(request.url).searchParams.get("q")).toBe(
      "is:pr is:public is:merged author:@me -user:@me merged:2025-10-01..2026-09-30",
    );
    expect(recipe.extractionShape).toBe("github_actor_id:oprf-raw");
  });

  test("requires at least five merged pull requests and the signed-in account capture", () => {
    for (const count of [5, 9, 10, 250]) {
      expect(separateParams(extract(response(count)))).toEqual({
        publicParams: { github_actor_id: "12345678" },
        secretParams: {},
      });
    }
    for (const body of [response(0), response(4), '<script>{"totalCount":9}</script>']) {
      expect(describeRequestMatch({ url: request.url, method: "GET", responseText: body }, request).matched).toBe(false);
    }
  });
});
