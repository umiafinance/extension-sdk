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

// The expected allowlist, kept independent of the recipe files.
const CLANS = [
  {
    "name": "Sparsity",
    "id": "87c22801-d5a6-4e9e-8f18-bceadf8b1040",
    "recommended": true
  },
  {
    "name": "Fantom Troupe",
    "id": "715a68a6-657e-4424-8c65-68ad3af899b1",
    "recommended": true
  },
  {
    "name": "Risk On",
    "id": "fc94d51d-4a71-4078-a635-77a11c94a2e9",
    "recommended": true
  },
  {
    "name": "WAGMI",
    "id": "ea30cc45-bc73-40d5-b909-9d2f49f9bace",
    "recommended": true
  },
  {
    "name": "The Big Blue",
    "id": "5481c4c8-b0fe-496a-b583-6890a677d5d5",
    "recommended": true
  },
  {
    "name": "Boogle",
    "id": "ec2aef5b-7370-4a5e-87c9-3053dba02458",
    "recommended": true
  },
  {
    "name": "Dabal",
    "id": "75cefc60-e6f6-4189-8073-18e7cb37db5d",
    "recommended": true
  },
  {
    "name": "Unipcs",
    "id": "7ec62252-3512-435d-a682-5941ee308cda",
    "recommended": false
  },
  {
    "name": "HFT",
    "id": "9769b8df-1a28-46d7-80e4-dc64f6377831",
    "recommended": false
  },
  {
    "name": "Nobi Ventures",
    "id": "11e5d07c-6f1d-4aa7-8a0d-aacf1c5f2033",
    "recommended": false
  },
  {
    "name": "Grand",
    "id": "e5857909-6100-4425-869f-681beb2be75b",
    "recommended": false
  },
  {
    "name": "Prosperity Customer Funds",
    "id": "d0f8fd50-ad7a-4138-b1d7-f25d685ec799",
    "recommended": false
  },
  {
    "name": "Heaven",
    "id": "80b2cce3-6a0f-47f5-a9e0-ef48baa81309",
    "recommended": false
  },
  {
    "name": "UWU",
    "id": "ee815f8f-7530-4e59-af85-26d9db5a6fe0",
    "recommended": false
  },
  {
    "name": "One Life",
    "id": "22952276-1424-4e49-806f-cdea7a1602ef",
    "recommended": false
  },
  {
    "name": "BIN",
    "id": "5f22ff37-534c-41bb-bbde-b51b1625280a",
    "recommended": false
  },
  {
    "name": "Hedgooor",
    "id": "80159dbe-a27d-49f3-8a16-322d054ddb7f",
    "recommended": false
  },
  {
    "name": "IncelTradingDesk",
    "id": "1ee52238-f464-41ac-ba2e-e7fb86237403",
    "recommended": false
  },
  {
    "name": "Ender",
    "id": "659b4a4b-5063-4815-b5bc-239109e68dd7",
    "recommended": false
  }
];

const USER = "d16c8d0d-0000-4000-8000-000000000001";
const OTHER = "0afc9a35-0000-4000-8000-000000000002";
const profileUrl = (id) => `https://prod-api.fomo.family/v2/users/${id}`;
const profile = (clan, extra = {}) => JSON.stringify({
  success: true,
  responseObject: { id: USER, address: "fixture-address", clan, ...extra },
  statusCode: 200,
});

for (const scope of ["recommended", "all-listed"]) {
  describe(`Fomo clan membership — ${scope}`, () => {
    const prepared = prepareProviderJson(readFileSync(
      new URL(`../../providers/recipes/fomo-clan-lists/${scope}.json`, import.meta.url), "utf8",
    ));
    const { candidate } = prepared;
    const [identity, activity] = candidate.providerConfigs[0].requestData;
    const matches = (body) => describeRequestMatch({
      url: profileUrl(USER), method: "GET", responseText: body,
    }, activity).matched;
    const extract = (request, body, url = request.url) => separateParams(
      extractParamsFromResponse(body, request.responseMatches, request.responseRedactions,
        extractParamsFromUrl(request.url, url)),
    );

    test("registry accepts two required proofs in the existing Fomo namespace", () => {
      expect(validateProviderDraft(candidate).errors).toEqual([]);
      expect(prepared.extractionShape).toBe("fomo_user:oprf-raw");
      expect(candidate.identityProvider).toBe("fomo");
      expect(candidate.providerConfigs).toHaveLength(1);
      expect(candidate.providerConfigs[0].requestData).toHaveLength(2);
      expect(deriveClaimHashRequirements(candidate)[0].hashes.map((hash) => hash.required !== false))
        .toEqual([true, true]);
      expect(ZKTLS_PROVIDERS[`fomo-clans-${scope}`].id).toBe(candidate.id);
    });

    test("accepts exactly the supplied clan IDs, independent of names and roles", () => {
      for (const clan of CLANS) {
        const eligible = scope === "all-listed" || clan.recommended;
        for (const role of ["member", "admin", "owner"]) {
          expect(matches(profile({ id: clan.id, name: "Renamed clan", role }))).toBe(eligible);
        }
      }
      const ids = activity.responseMatches[1].value.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g);
      expect(ids).toEqual(CLANS.filter((clan) => scope === "all-listed" || clan.recommended).map((clan) => clan.id));
    });

    test("rejects missing, unknown and lookalike IDs, even with an approved name", () => {
      for (const clan of [null, undefined,
        { id: OTHER, name: "Sparsity" },
        { id: `${CLANS[0].id}0`, name: "Sparsity" },
        { id: `0${CLANS[0].id}`, name: "Sparsity" },
        { id: CLANS[0].id.slice(0, -1), name: "Sparsity" },
        { name: "Sparsity" },
      ]) expect(matches(profile(clan))).toBe(false);
      expect(matches(profile(null, {
        description: `"clan":{"id":"${CLANS[0].id}","name":"Sparsity"}`,
      }))).toBe(false);
    });

    test("extracts the account consistently and hides all UUID URL segments", () => {
      const body = profile({ id: CLANS[0].id, name: CLANS[0].name });
      const session = extract(identity, body);
      const own = extract(activity, body, profileUrl(USER));
      expect(session).toEqual({ publicParams: { fomo_user: USER }, secretParams: {} });
      expect(own).toEqual({
        publicParams: { fomo_user: USER },
        secretParams: Object.fromEntries(USER.split("-").map((part, i) => [`URL_PARAM_${i + 1}_SECRET`, part])),
      });
      expect(activity.writeRedactionMode).toBe("zk");
      const other = extract(activity, profile({ id: CLANS[0].id, name: CLANS[0].name }, { id: OTHER }), profileUrl(OTHER));
      expect(other.publicParams.fomo_user).not.toBe(session.publicParams.fomo_user);
      expect(extract(activity, profile({ id: CLANS[1].id, name: CLANS[1].name }), profileUrl(USER))).toEqual(own);
    });

    test("derives the complete private profile URL from the session account", () => {
      const chain = candidate.providerRuntime.requestChain;
      expect(chain.readyUrl).toBe("https://prod-api.fomo.family/v2/users/pin");
      expect(chain.responseParameters).toHaveLength(5);
      const parameters = Object.fromEntries(chain.responseParameters.map((mapping) => {
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

    test("reveals enough clan data to verify membership without the account or clan name", () => {
      const body = profile({ id: CLANS[0].id, name: CLANS[0].name });
      const [range] = resolveRedaction(body, activity.responseRedactions[1]);
      expect(range.value).toBe(`"clan":{"id":"${CLANS[0].id}","name":"`);
      expect(new RegExp(activity.responseMatches[1].value).test(`***${range.value}***`)).toBe(true);
      expect(range.value).not.toContain(USER);
      expect(range.value).not.toContain(CLANS[0].name);
    });
  });
}
