import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ZKTLS_PROVIDERS } from "../../../types/src/zktls-providers.ts";
import { deriveClaimHashRequirements } from "../../providers/src/providers/hash.ts";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { validateProviderDraft } from "../../providers/src/providers/validate.ts";
import { resolveRedaction } from "../src/utils/claim-creator/attestor-extraction.js";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import {
  extractParamsFromResponse,
  extractParamsFromUrl,
  separateParams,
} from "../src/utils/claim-creator/params-extractor.js";

const USER = "d16c8d0d-0000-4000-8000-000000000001";
const OTHER = "0afc9a35-0000-4000-8000-000000000002";
const profileUrl = (id) => `https://prod-api.fomo.family/v2/users/${id}`;
const profile = (seconds, extra = {}) =>
  JSON.stringify({
    success: true,
    responseObject: { id: USER, address: "fixture-address", averageHoldTimeSeconds: seconds, socials: [], ...extra },
    statusCode: 200,
  });

for (const days of [30, 5]) {
  describe(`FOMO average hold time > ${days} days`, () => {
    const prepared = prepareProviderJson(
      readFileSync(
        new URL(`../../providers/recipes/fomo-hold-time/more-than-${days}-days.json`, import.meta.url),
        "utf8",
      ),
    );
    const { candidate } = prepared;
    const [identity, activity] = candidate.providerConfigs[0].requestData;
    const threshold = days * 86_400;
    const matches = (body) =>
      describeRequestMatch({ url: profileUrl(USER), method: "GET", responseText: body }, activity)
        .matched;
    const extract = (request, body, url = request.url) =>
      separateParams(
        extractParamsFromResponse(
          body,
          request.responseMatches,
          request.responseRedactions,
          extractParamsFromUrl(request.url, url),
        ),
      );

    test("saves under the shared FOMO identity and requires ownership plus hold time", () => {
      expect(validateProviderDraft(candidate).errors).toEqual([]);
      expect(prepared.extractionShape).toBe("fomo_user:oprf-raw");
      expect(candidate.identityProvider).toBe("fomo");
      expect(candidate.providerConfigs).toHaveLength(1);
      expect(candidate.providerConfigs[0].requestData).toHaveLength(2);
      expect(deriveClaimHashRequirements(candidate)[0].hashes.map((hash) => hash.required !== false)).toEqual([
        true,
        true,
      ]);
      expect(ZKTLS_PROVIDERS[`fomo-hold-time-over-${days}-days`].id).toBe(candidate.id);
    });

    test("uses a strict seconds threshold, including fractional seconds", () => {
      for (const seconds of [null, undefined, -1, 0, 86_400, threshold - 1, threshold - 0.1, threshold]) {
        expect(matches(profile(seconds))).toBe(false);
      }
      for (const seconds of [threshold + 0.0001, threshold + 0.1, threshold + 1, threshold * 2, threshold * 10]) {
        expect(matches(profile(seconds))).toBe(true);
        expect(resolveRedaction(profile(seconds), activity.responseRedactions[1])).toHaveLength(1);
      }
      // Check the regex's decimal digit boundaries against the numeric predicate.
      for (let seconds = 0; seconds <= threshold * 3; seconds += 97) {
        expect(matches(profile(seconds))).toBe(seconds > threshold);
      }
    });

    test("rejects strings, malformed numbers and description text pretending to be the metric", () => {
      const qualifying = threshold + 1;
      for (const seconds of [`${qualifying}`, `${qualifying} days`, true]) {
        expect(matches(profile(seconds))).toBe(false);
      }
      expect(
        matches(profile(null, { description: `"averageHoldTimeSeconds":${qualifying},` })),
      ).toBe(false);
      for (const value of [`0${qualifying}`, `${qualifying}oops`, `${threshold}.000`, "1e6"]) {
        const body = profile(null).replace('"averageHoldTimeSeconds":null', `"averageHoldTimeSeconds":${value}`);
        expect(matches(body)).toBe(false);
      }
    });

    test("keeps the numeric fact out of the extracted identity and hides every UUID URL segment", () => {
      const body = profile(threshold + 1);
      const session = extract(identity, body);
      const own = extract(activity, body, profileUrl(USER));
      expect(session).toEqual({ publicParams: { fomo_user: USER }, secretParams: {} });
      expect(own).toEqual({
        publicParams: { fomo_user: USER },
        secretParams: Object.fromEntries(USER.split("-").map((part, i) => [`URL_PARAM_${i + 1}_SECRET`, part])),
      });
      expect(activity.writeRedactionMode).toBe("zk");
      const other = extract(activity, profile(threshold + 1, { id: OTHER }), profileUrl(OTHER));
      expect(other.publicParams.fomo_user).not.toBe(session.publicParams.fomo_user);
      // The same account remains the subject when its average changes.
      expect(extract(activity, profile(threshold + 100), profileUrl(USER))).toEqual(own);
    });

    test("the request chain keeps all five UUID segments secret, with no public fragment", () => {
      const mappings = candidate.providerRuntime.requestChain.responseParameters;
      expect(mappings).toHaveLength(5);
      const parameters = Object.fromEntries(mappings.map((mapping) => {
        expect(mapping.requestIndex).toBe(0);
        expect(mapping.path).toEqual(["responseObject", "id"]);
        expect(mapping.parameter).toMatch(/^URL_PARAM_[1-5]_SECRET$/);
        return [mapping.parameter, USER.slice(...mapping.slice)];
      }));
      expect(Object.values(parameters)).toEqual(USER.split("-"));
      expect(Math.max(...Object.values(parameters).map((value) => value.length))).toBe(12);
      expect(activity.url.replace(/\{\{(\w+)\}\}/g, (_, key) => parameters[key])).toBe(profileUrl(USER));
      expect(separateParams(parameters).publicParams).toEqual({});
      expect(activity.responseVariables.filter((name) => !name.includes("SECRET"))).toEqual(["fomo_user"]);
      expect(JSON.stringify(candidate)).not.toContain("fomo_url_fragment");
    });

    test("the revealed metric satisfies the signed response rule without other profile data", () => {
      const body = profile(threshold + 1);
      const [range] = resolveRedaction(body, activity.responseRedactions[1]);
      expect(range.value).toBe(`"averageHoldTimeSeconds":${threshold + 1},`);
      expect(new RegExp(activity.responseMatches[1].value).test(`***${range.value}***`)).toBe(true);
      expect(range.value).not.toContain(USER);
    });
  });
}
