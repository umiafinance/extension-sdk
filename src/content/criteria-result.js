import { MATCH_STAGES } from "../utils/claim-creator/network-filter.js";

const GITHUB_ACTOR_MATCH = '<meta name="octolytics-actor-id" content="{{github_actor_id}}" />';
const GITHUB_COUNT_FIELDS = new Map([
  ['"totalCount":(?:[1-9][0-9]*)\\b', "totalCount"],
  ['"totalCount":(?:[5-9]|[1-9][0-9]+)\\b', "totalCount"],
  ['"result_count":(?:[1-9][0-9]*)\\b', "result_count"],
]);

/**
 * The current GitHub recipes first match an authenticated actor, then a numeric
 * search count. A missing positive regex is inconclusive until that count is
 * actually present in one complete, successful response. Other recipe shapes
 * remain inconclusive; they need their own explicit failure evidence.
 */
export function isEligibilityResponseMismatch(criteria, verdict, response) {
  if (
    verdict?.stage !== MATCH_STAGES.RESPONSE_MATCH ||
    verdict.failedMatchIndex !== 1 ||
    !Number.isInteger(response?.status) ||
    response.status < 200 ||
    response.status >= 300 ||
    typeof response.body !== "string" ||
    criteria?.responseVariables?.length !== 1 ||
    criteria.responseVariables[0] !== "github_actor_id" ||
    criteria?.responseMatches?.length !== 2 ||
    criteria.responseMatches[0].type !== "contains" ||
    criteria.responseMatches[0].value !== GITHUB_ACTOR_MATCH
  ) {
    return false;
  }

  const rule = criteria.responseMatches[1];
  const field = rule?.type === "regex" ? GITHUB_COUNT_FIELDS.get(rule.value) : null;
  if (!field) return false;
  const counts = [...response.body.matchAll(new RegExp(`"${field}":([0-9]+)\\b`, "g"))];
  return counts.length === 1 && Number.isSafeInteger(Number(counts[0][1]));
}
