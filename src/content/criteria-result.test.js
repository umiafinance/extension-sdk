import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { describeRequestMatch } from "../utils/claim-creator/network-filter.js";
import { isEligibilityResponseMismatch } from "./criteria-result.js";

describe("eligibility mismatch evidence", () => {
  const actor = '<meta name="octolytics-actor-id" content="123" />';
  const rules = {
    url: "https://github.com/search",
    method: "GET",
    responseVariables: ["github_actor_id"],
    responseMatches: [
      {
        type: "contains",
        value: '<meta name="octolytics-actor-id" content="{{github_actor_id}}" />',
      },
      { type: "regex", value: '"totalCount":(?:[5-9]|[1-9][0-9]+)\\b' },
    ],
  };
  const check = (body, status = 200, config = rules) => {
    const verdict = describeRequestMatch(
      { url: config.url, method: "GET", responseText: body },
      config,
    );
    return isEligibilityResponseMismatch(config, verdict, { status, body });
  };

  it("accepts a completed authenticated response with a below-threshold count", () => {
    assert.equal(check(`${actor}"totalCount":3`), true);
    assert.equal(check(`${actor}"totalCount":5`), false);
    const maintainer = {
      ...rules,
      responseMatches: [
        rules.responseMatches[0],
        { type: "regex", value: '"result_count":(?:[1-9][0-9]*)\\b' },
      ],
    };
    assert.equal(check(`${actor}"result_count":0`, 200, maintainer), true);
  });

  it("recognizes every current GitHub search recipe", () => {
    const directory = new URL("../../../providers/recipes/github-2026q3/", import.meta.url);
    const recipes = readdirSync(directory).filter((name) => name.endsWith(".json"));
    assert.ok(recipes.length > 0);
    for (const file of recipes) {
      const recipe = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
      const config = recipe.providerConfigs[0].requestData[0];
      const field = config.responseMatches[1].value.includes("result_count")
        ? "result_count"
        : "totalCount";
      assert.equal(check(`${actor}"${field}":0`, 200, config), true, file);
    }
  });

  it("ignores sign-in, loading, error, and ambiguous responses", () => {
    assert.equal(check('"totalCount":0'), false, "no authenticated actor");
    assert.equal(check(actor), false, "the count has not loaded");
    assert.equal(check(`${actor}"totalCount":0`, 401), false, "HTTP failure");
    assert.equal(check(`${actor}"totalCount":0"totalCount":0`), false, "ambiguous count");
    assert.equal(check(`${actor}"totalCount":0`, 200, { ...rules, responseVariables: [] }), false);
    assert.equal(
      check(`${actor}"otherCount":0`, 200, {
        ...rules,
        responseMatches: [rules.responseMatches[0], { type: "regex", value: '"otherCount":[1-9]' }],
      }),
      false,
      "unreviewed recipe shape",
    );
  });
});
