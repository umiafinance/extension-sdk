import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prepareProviderJson } from "../../providers/src/providers/registry-manager.ts";
import { validateProviderDraft } from "../../providers/src/providers/validate.ts";
import { describeRequestMatch } from "../src/utils/claim-creator/network-filter.js";
import {
  extractParamsFromResponse,
  extractParamsFromUrl,
  separateParams,
} from "../src/utils/claim-creator/params-extractor.js";

const RECIPES = {
  clanMember: "fomo-clans/clan-member.json",
  noClan: "fomo-clans/no-clan.json",
};

function recipe(key) {
  const raw = readFileSync(
    new URL(`../../providers/recipes/${RECIPES[key]}`, import.meta.url),
    "utf8",
  );
  return prepareProviderJson(raw);
}

function request(key, index) {
  return recipe(key).candidate.providerConfigs[0].requestData[index];
}

function extract(key, index, response, url = request(key, index).url) {
  const entry = request(key, index);
  const params = extractParamsFromResponse(
    response,
    entry.responseMatches,
    entry.responseRedactions,
    extractParamsFromUrl(entry.url, url),
  );
  return separateParams(params);
}

function matches(key, index, response, url = request(key, index).url) {
  const entry = request(key, index);
  return describeRequestMatch({ url, method: entry.method, responseText: response }, entry);
}

const USER = "d16c8d0d-0000-4000-8000-000000000001";
const OTHER = "0afc9a35-0000-4000-8000-000000000002";

const fomoUser = ({ id = OTHER, clan = null } = {}) =>
  JSON.stringify({
    success: true,
    message: "User found",
    responseObject: {
      id,
      address: "9ChD54pcuJ9qS7mRv3KkM4XztL76GDot6DZKcj1FJrys",
      userHandle: "GiantTallSmelt",
      description: '","clan":{"id":"00000000-0000-4000-8000-000000000009","name":"',
      clan,
      followsCurrentUser: false,
    },
    statusCode: 200,
  });

const CLAN = { id: "c970bdea-90bc-4e6a-b05f-73e9087daf35", name: "fomo umia test", role: "member" };

describe("connected recipes for fomo clans", () => {
  for (const key of Object.keys(RECIPES)) {
    test(`${key} saves as one provider with two required requests and one subject key`, () => {
      const prepared = recipe(key);
      const lint = validateProviderDraft(prepared.candidate);
      expect(lint.errors).toEqual([]);
      expect(lint.warnings).toEqual([]);
      expect(prepared.candidate.providerConfigs).toHaveLength(1);
      expect(prepared.candidate.providerConfigs[0].requestData).toHaveLength(2);
      expect(prepared.claimHashes).toHaveLength(2);
    });
  }

  test("fomo captures the same account id from the session request and the own profile", () => {
    const own = `https://prod-api.fomo.family/v2/users/${OTHER}`;
    for (const key of ["clanMember", "noClan"]) {
      expect(recipe(key).extractionShape).toBe("fomo_user:oprf-raw");
      expect(request(key, 1).writeRedactionMode).toBe("zk");
      expect(extract(key, 0, fomoUser())).toEqual({
        publicParams: { fomo_user: OTHER },
        secretParams: {},
      });
    }
    expect(matches("clanMember", 1, fomoUser({ clan: CLAN }), own)).toEqual({
      matched: true,
      stage: "matched",
    });
    expect(extract("clanMember", 1, fomoUser({ clan: CLAN }), own)).toEqual({
      publicParams: { fomo_user: OTHER },
      secretParams: {
        URL_PARAM_1_SECRET: OTHER.slice(0, 8),
        URL_PARAM_2_SECRET: OTHER.slice(9, 13),
        URL_PARAM_3_SECRET: OTHER.slice(14, 18),
        URL_PARAM_4_SECRET: OTHER.slice(19, 23),
        URL_PARAM_5_SECRET: OTHER.slice(24, 36),
      },
    });
    expect(extract("noClan", 1, fomoUser(), own)).toEqual({
      publicParams: { fomo_user: OTHER },
      secretParams: {
        URL_PARAM_1_SECRET: OTHER.slice(0, 8),
        URL_PARAM_2_SECRET: OTHER.slice(9, 13),
        URL_PARAM_3_SECRET: OTHER.slice(14, 18),
        URL_PARAM_4_SECRET: OTHER.slice(19, 23),
        URL_PARAM_5_SECRET: OTHER.slice(24, 36),
      },
    });
  });

  test("fomo's clan rules read the clan object, not a description that imitates it", () => {
    const own = `https://prod-api.fomo.family/v2/users/${OTHER}`;
    expect(matches("clanMember", 1, fomoUser(), own).matched).toBe(false);
    expect(matches("noClan", 1, fomoUser({ clan: CLAN }), own).matched).toBe(false);
  });

  test("fomo accepts only the allowed clan ID, independently of the clan's name", () => {
    const own = `https://prod-api.fomo.family/v2/users/${OTHER}`;
    for (const clan of [CLAN, { ...CLAN, role: "admin" }, { ...CLAN, name: "Renamed clan" }]) {
      expect(matches("clanMember", 1, fomoUser({ clan }), own).matched).toBe(true);
    }
    for (const clan of [
      null,
      { ...CLAN, id: "75c4e351-f125-4714-b843-d592985ba534" },
      { ...CLAN, id: `${CLAN.id}0` },
    ]) {
      expect(matches("clanMember", 1, fomoUser({ clan }), own).matched).toBe(false);
    }
    const spoof = JSON.parse(fomoUser());
    spoof.responseObject.description = JSON.stringify({ clan: CLAN });
    expect(matches("clanMember", 1, JSON.stringify(spoof), own).matched).toBe(false);
  });

  test("fomo's profile of another member yields a different subject than the session", () => {
    const member = `https://prod-api.fomo.family/v2/users/${USER}`;
    const session = extract("clanMember", 0, fomoUser()).publicParams.fomo_user;
    const profile = extract("clanMember", 1, fomoUser({ id: USER, clan: CLAN }), member);
    expect(profile.secretParams).toEqual({
      URL_PARAM_1_SECRET: USER.slice(0, 8),
      URL_PARAM_2_SECRET: USER.slice(9, 13),
      URL_PARAM_3_SECRET: USER.slice(14, 18),
      URL_PARAM_4_SECRET: USER.slice(19, 23),
      URL_PARAM_5_SECRET: USER.slice(24, 36),
    });
    expect(profile.publicParams.fomo_user).not.toBe(session);
  });

  test("fomo's declarative request chain derives the own profile from the signed-in account", () => {
    for (const key of ["clanMember", "noClan"]) {
      const prepared = recipe(key);
      expect(prepared.candidate.providerRuntime.customInjection).toBeUndefined();
      expect(prepared.candidate.providerRuntime.requestChain).toEqual({
        readyUrl: "https://prod-api.fomo.family/v2/users/pin",
        responseParameters: [
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_1_SECRET",
            slice: [0, 8],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_2_SECRET",
            slice: [9, 13],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_3_SECRET",
            slice: [14, 18],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_4_SECRET",
            slice: [19, 23],
          },
          {
            requestIndex: 0,
            path: ["responseObject", "id"],
            parameter: "URL_PARAM_5_SECRET",
            slice: [24, 36],
          },
        ],
      });
    }
  });
});
