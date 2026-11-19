import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ZKTLS_PROVIDERS } from "../../../types/src/zktls-providers.ts";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { resolveRedaction } from "../src/utils/claim-creator/attestor-extraction.js";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";

function profile(humanVerificationStatus, score) {
  return { humanVerificationStatus, profileId: 42, score, userkey: "profileId:42" };
}

for (const [name, threshold, needsVerification] of [
  ["human-verified-1400", 1400, true],
  ["human-verified-1200", 1200, true],
  ["score-1200", 1200, false],
]) {
  describe(name, () => {
    const file = new URL(`../../providers/recipes/ethos/${name}.json`, import.meta.url);
    const prepared = prepareProviderJson(readFileSync(file, "utf8"));
    const [request] = prepared.candidate.providerConfigs[0].requestData;

    function matches(response, url = request.url) {
      return describeRequestMatch({ url, method: "GET", responseText: JSON.stringify(response) }, request).matched;
    }

    test("the fixed session endpoint supplies one private Ethos identity", () => {
      expect(ZKTLS_PROVIDERS[`ethos-${name}`].id).toBe(prepared.candidate.id);
      expect(prepared.extractionShape).toBe("ethos_profile_id:oprf-raw");
      const eligible = { profile: profile("VERIFIED", threshold) };
      const body = JSON.stringify(eligible);
      expect(resolveRedaction(body, request.responseRedactions[0]).map((match) => match.value)).toEqual(["42"]);
      expect(resolveRedaction(body, request.responseRedactions[1])).toHaveLength(1);
      expect(matches(eligible, request.url + "?subjectUserkey=profileId:42")).toBe(false);
    });

    test("applies the inclusive score threshold and the configured verification requirement", () => {
      for (const status of ["VERIFIED", "REQUESTED", "PENDING", "REVOKED", null]) {
        for (const score of [threshold, threshold + 1, 1999, 2000, 10000]) {
          expect(matches({ profile: profile(status, score) })).toBe(status === "VERIFIED" || !needsVerification);
        }
        for (const score of [threshold - 1, null, String(threshold), undefined]) {
          expect(matches({ profile: profile(status, score) })).toBe(false);
        }
      }
      expect(matches({ profile: null })).toBe(false);
      expect(matches({ code: "UNAUTHORIZED" })).toBe(false);
    });
  });
}
