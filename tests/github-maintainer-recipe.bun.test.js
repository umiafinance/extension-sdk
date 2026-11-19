import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ZKTLS_PROVIDERS, githubGateSearchUrl } from "../../../types/src/zktls-providers.ts";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import { extractParamsFromResponse, separateParams } from "../src/utils/claim-creator/params-extractor.js";

const read = (name) => readFileSync(new URL(`../../providers/recipes/github-2026q3/${name}`, import.meta.url), "utf8");
const current = prepareProviderJson(read("maintainer-50-stars-before-2026-09-30.json"));
const request = current.candidate.providerConfigs[0].requestData[0];
const response = (count) => `<html><meta name="octolytics-actor-id" content="12345678" /><script>{"result_count":${count}}</script></html>`;
const extract = (body) => extractParamsFromResponse(body, request.responseMatches, request.responseRedactions, {});

describe("50-star maintainer creation cutoff (synthetic, not live proof evidence)", () => {
  test("pins ownership, stars and the exclusive September cutoff in one required request", () => {
    const pin = ZKTLS_PROVIDERS["github-maintainer"];
    expect(current.candidate.id).toBe(pin.id);
    expect(current.candidate.providerConfigs).toHaveLength(1);
    expect(current.candidate.providerConfigs[0].requestData).toHaveLength(1);
    expect(current.claimHashes).toHaveLength(1);
    expect(current.candidate.providerConfigs[0].loginUrl).toBe(request.url);
    expect(request.url).toBe(githubGateSearchUrl(pin.github));
    expect(new URL(request.url).searchParams.get("q")).toBe("user:@me stars:>=50 is:public created:<2026-09-30");
    expect(request.url).not.toContain("{{");
    expect(current.extractionShape).toBe("github_actor_id:oprf-raw");
  });

  test("rejects replaying a search without the creation cutoff", () => {
    const url = "https://github.com/search?q=user%3A%40me%20stars%3A%3E%3D50%20is%3Apublic&type=repositories";
    expect(describeRequestMatch({ url, method: "GET", responseText: response(1) }, request).matched).toBe(false);
    expect(describeRequestMatch({ url: request.url, method: "GET", responseText: response(1) }, request).matched).toBe(true);
  });

  test("requires at least one result and the signed-in account capture", () => {
    for (const count of [1, 2, 50]) {
      expect(separateParams(extract(response(count)))).toEqual({
        publicParams: { github_actor_id: "12345678" },
        secretParams: {},
      });
    }
    for (const body of [response(0), '<script>{"result_count":1}</script>']) {
      expect(describeRequestMatch({ url: request.url, method: "GET", responseText: body }, request).matched).toBe(false);
    }
  });
});
