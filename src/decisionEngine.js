import { MIN_IMPROVEMENT_HIGH, MIN_IMPROVEMENT_MEDIUM } from "./constants.js";
import { analyzePlan, detectPrimaryProblem } from "./planAnalysis.js";

function readTotalCost(plan) {
  const cost = plan?.Plan?.["Total Cost"];
  if (typeof cost !== "number" || Number.isNaN(cost)) return null;
  return cost;
}

export function comparePlanCosts(planBefore, planAfter) {
  const beforeCost = readTotalCost(planBefore);
  const afterCost = readTotalCost(planAfter) ?? beforeCost;
  if (beforeCost === null || afterCost === null || beforeCost <= 0) {
    return {
      beforeCost,
      afterCost,
      improvementPercent: 0
    };
  }

  return {
    beforeCost,
    afterCost,
    improvementPercent: ((beforeCost - afterCost) / beforeCost) * 100
  };
}

export function confidenceFromImprovement(improvement, hasClearMissingIndex) {
  // Strong deterministic signal: a concrete table+column index opportunity.
  if (hasClearMissingIndex) return "HIGH";
  // Low-confidence guardrail requested for weak gains.
  if (improvement < 20) return "LOW";
  if (improvement > MIN_IMPROVEMENT_HIGH) return "HIGH";
  if (improvement > MIN_IMPROVEMENT_MEDIUM) return "MEDIUM";
  return "LOW";
}

function buildSafeRecommendation(findings) {
  const candidate = findings.candidate || null;
  const hasTable = Boolean(candidate?.table);
  const hasColumn = Boolean(candidate?.column);
  const hasMetadata = hasTable && hasColumn;
  const isTrigram = candidate?.type === "trigram";

  if (!hasMetadata) {
    // Safety guard: never emit SQL when plan metadata is incomplete.
    if (findings.hasSeqScan) {
      return {
        fixSQL: null,
        sql: null,
        tradeoffs: [],
        tradeOffs: [],
        reason: "Unable to determine index column safely",
        skipped: "Suggestion skipped due to insufficient metadata"
      };
    }
    return {
      fixSQL: null,
      sql: null,
      tradeoffs: [],
      tradeOffs: [],
      reason: "Suggestion skipped due to insufficient metadata",
      skipped: "Suggestion skipped due to insufficient metadata"
    };
  }

  if (isTrigram) {
    // LIKE '%value' rule: only proceed when a valid column is known.
    return {
      fixSQL: candidate.sql,
      sql: candidate.sql,
      tradeoffs: ["May slow INSERT/UPDATE", "Additional disk usage"],
      tradeOffs: ["May slow INSERT/UPDATE", "Additional disk usage"],
      reason: candidate.reason
    };
  }

  return {
    fixSQL: candidate.sql,
    sql: candidate.sql,
    tradeoffs: ["May slow INSERT/UPDATE", "Additional disk usage"],
    tradeOffs: ["May slow INSERT/UPDATE", "Additional disk usage"],
    reason: candidate.reason
  };
}

function parseSqlCommenterContext(queryText) {
  const text = String(queryText || "");
  const commentMatch = text.match(/\/\*\s*([\s\S]*?)\s*\*\//);
  if (!commentMatch) {
    return {
      route: null,
      controller: null,
      functionName: null
    };
  }

  const payload = commentMatch[1];
  const readValue = (key) => {
    const re = new RegExp(`${key}\\s*=\\s*'([^']*)'`, "i");
    const m = payload.match(re);
    return m ? m[1] : null;
  };

  return {
    route: readValue("route"),
    controller: readValue("controller"),
    functionName: readValue("function")
  };
}

function detectNPlusOne(stats) {
  const calls = Number(stats?.calls) || 0;
  const rows = Number(stats?.rows) || 0;
  if (calls <= 20) return false;
  // Basic deterministic heuristic: many executions with tiny result batches.
  return rows >= 0 && rows / calls <= 1;
}

function buildTriggerMessage(context) {
  const controller = context.controller;
  const route = context.route;
  const functionName = context.functionName;

  if (controller && route) {
    return `Slow query triggered by ${controller} (${route} route)`;
  }
  if (controller && functionName) {
    return `Slow query triggered by ${controller}.${functionName}`;
  }
  if (route) {
    return `Slow query triggered by ${route} route`;
  }
  return null;
}

function buildRootCauseExplanation({ context, primaryProblem, recommendation, hasNPlusOne }) {
  const trigger = buildTriggerMessage(context) || "This query";
  const table = recommendation?.table;
  const column = recommendation?.column;
  const indexCause =
    table && column
      ? `performs a full table scan due to a missing index on ${table}.${column}.`
      : `${primaryProblem.toLowerCase()}.`;

  if (hasNPlusOne) {
    return `${trigger} is executed repeatedly with small result sets. Possible N+1 query detected from application layer; it also ${indexCause}`;
  }
  return `${trigger} ${indexCause}`;
}

function buildCodeAdvice(recommendation, hasNPlusOne) {
  const table = recommendation?.table;
  const column = recommendation?.column;
  const advice = [];
  if (table && column) {
    advice.push(`- Add index on ${table}.${column}`);
    advice.push("- Ensure ORM uses indexed field");
  } else {
    advice.push("- Review query builder/ORM filters to use indexed columns");
  }
  if (hasNPlusOne) {
    advice.push("- Batch related lookups to avoid per-row query loops");
  }
  return advice;
}

export function buildDiagnosis({ queryText, planBefore, planAfter, stats }) {
  const findings = analyzePlan(planBefore, queryText);
  const { beforeCost, afterCost, improvementPercent } = comparePlanCosts(
    planBefore,
    planAfter
  );
  const hasClearMissingIndex = Boolean(
    findings.candidate?.table && findings.candidate?.column && findings.candidate?.sql
  );
  const confidence = confidenceFromImprovement(improvementPercent, hasClearMissingIndex);
  const recommendation = buildSafeRecommendation(findings);
  const appContext = parseSqlCommenterContext(queryText);
  const nPlusOne = detectNPlusOne(stats);
  const triggerMessage = buildTriggerMessage(appContext);
  const primaryProblem = detectPrimaryProblem(findings);

  return {
    queryText,
    primaryProblem,
    recommendation,
    estimatedRowsScanned: findings.estimatedRowsScanned,
    beforeCost,
    afterCost,
    improvement: improvementPercent,
    confidence,
    note:
      improvementPercent < 20
        ? "Performance improvement is minimal; consider alternative optimizations"
        : null,
    appContext,
    triggerMessage,
    nPlusOne,
    rootCause: buildRootCauseExplanation({
      context: appContext,
      primaryProblem,
      recommendation,
      hasNPlusOne: nPlusOne
    }),
    codeAdvice: buildCodeAdvice(recommendation, nPlusOne),
    stats
  };
}
