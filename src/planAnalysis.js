function walkPlan(node, visitFn) {
  visitFn(node);
  const children = node.Plans || [];
  for (const child of children) {
    walkPlan(child, visitFn);
  }
}

function getNodeTable(node) {
  return node["Relation Name"] || null;
}

function extractSinglePredicateColumn(expression) {
  if (!expression || typeof expression !== "string") return null;
  const regex = /(?:(?:\b([a-zA-Z_][a-zA-Z0-9_]*)\.)?\b([a-zA-Z_][a-zA-Z0-9_]*))\s*(=|>|<|>=|<=|~~|!~~|\bLIKE\b|\bILIKE\b)/gi;
  const refs = [];
  let match;
  while ((match = regex.exec(expression)) !== null) {
    refs.push({
      table: match[1] || null,
      column: match[2]
    });
  }
  if (refs.length !== 1) return null;
  return refs[0];
}

function extractLeadingWildcardLikeColumn(filterExpr) {
  if (!filterExpr || typeof filterExpr !== "string") return null;
  // Only treat LIKE as actionable when plan filter clearly shows a leading wildcard literal.
  const regex = /(?:(?:\b([a-zA-Z_][a-zA-Z0-9_]*)\.)?\b([a-zA-Z_][a-zA-Z0-9_]*))\s*(~~\*?|!~~\*?|\bLIKE\b|\bILIKE\b)\s*'%/i;
  const match = filterExpr.match(regex);
  if (!match) return null;
  return {
    table: match[1] || null,
    column: match[2]
  };
}

function normalizeSortExpression(sortExpr) {
  if (!sortExpr || typeof sortExpr !== "string") return null;
  return sortExpr
    .replace(/::[a-zA-Z0-9_\[\]\s]+/g, "")
    .replace(/\s+(ASC|DESC)\b/gi, "")
    .replace(/\s+NULLS\s+(FIRST|LAST)\b/gi, "")
    .trim();
}

function extractSortColumnRef(sortExpr) {
  const normalized = normalizeSortExpression(sortExpr);
  if (!normalized) return null;
  // Accept only direct column refs; skip expressions/functions to avoid guessing.
  const match = normalized.match(/^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (!match) return null;
  return {
    table: match[1] || null,
    column: match[2]
  };
}

function extractSingleJoinColumn(node) {
  const joinExpr = `${node["Hash Cond"] || ""} ${node["Merge Cond"] || ""} ${node["Join Filter"] || ""}`.trim();
  if (!joinExpr) return null;
  const regex = /(?:\b([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:\b([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const pairs = [];
  let match;
  while ((match = regex.exec(joinExpr)) !== null) {
    pairs.push([
      { table: match[1] || null, column: match[2] },
      { table: match[3] || null, column: match[4] }
    ]);
  }
  if (pairs.length !== 1) return null;
  // Ambiguous if both sides lack table qualification.
  if (!pairs[0][0].table && !pairs[0][1].table) return null;
  return pairs[0][0].table ? pairs[0][0] : pairs[0][1];
}

function buildRecommendationForLike(relation, column, reason) {
  const indexName = `idx_${relation}_${column}_trgm`.replace(/[^a-zA-Z0-9_]/g, "_");
  return {
    type: "trigram",
    table: relation,
    column,
    reason,
    sql: `CREATE INDEX CONCURRENTLY ${indexName} ON ${relation} USING gin (${column} gin_trgm_ops);`,
    tradeOffs: ["+ Much faster wildcard text search", "- Slightly slower writes and more storage"]
  };
}

function buildRecommendationForBtree(relation, column, reason) {
  return {
    type: "btree",
    table: relation,
    column,
    reason,
    sql: `CREATE INDEX ON ${relation} (${column});`,
    tradeOffs: ["+ Faster read/query latency", "- Slight write overhead and extra storage"]
  };
}

function buildRecommendationForOrderBy(relation, column, reason) {
  const indexName = `idx_${relation}_${column}`.replace(/[^a-zA-Z0-9_]/g, "_");
  return {
    type: "btree",
    table: relation,
    column,
    reason,
    sql: `CREATE INDEX CONCURRENTLY ${indexName} ON ${relation}(${column});`,
    tradeOffs: ["+ Faster read/query latency", "- Slight write overhead and extra storage"]
  };
}

function buildSeqScanCandidate(node) {
  const relation = getNodeTable(node);
  if (!relation) return null;

  const likeRef = extractLeadingWildcardLikeColumn(node.Filter);
  if (likeRef?.column) {
    return buildRecommendationForLike(
      relation,
      likeRef.column,
      "Leading wildcard LIKE prevents btree index usage."
    );
  }

  const predicateRef = extractSinglePredicateColumn(`${node.Filter || ""} ${node["Index Cond"] || ""}`);
  if (!predicateRef?.column) return null;
  return buildRecommendationForBtree(
    relation,
    predicateRef.column,
    "Sequential scan with clear filter predicate suggests a missing index."
  );
}

function buildSortCandidate(node) {
  if (!Array.isArray(node["Sort Key"]) || node["Sort Key"].length !== 1) return null;
  const sortRef = extractSortColumnRef(node["Sort Key"][0]);
  if (!sortRef?.column) return null;

  // Sort nodes usually reference child relation; require known table to avoid bad SQL.
  const child = Array.isArray(node.Plans) ? node.Plans[0] : null;
  const relation = child ? getNodeTable(child) : null;
  if (!relation) return null;

  return buildRecommendationForOrderBy(
    relation,
    sortRef.column,
    "Sort key suggests index could reduce ORDER BY cost."
  );
}

function buildJoinCandidate(node) {
  const joinRef = extractSingleJoinColumn(node);
  if (!joinRef?.table || !joinRef?.column) return null;
  return buildRecommendationForBtree(
    joinRef.table,
    joinRef.column,
    "Join condition suggests a missing index on join key."
  );
}

export function analyzePlan(planJson, queryText) {
  const planRoot = planJson.Plan;
  const findings = {
    hasSeqScan: false,
    hasSort: false,
    estimatedRowsScanned: 0,
    candidate: null
  };

  walkPlan(planRoot, (node) => {
    const nodeType = node["Node Type"];

    if (nodeType === "Seq Scan") {
      findings.hasSeqScan = true;
      findings.estimatedRowsScanned += node["Plan Rows"] || 0;
      if (!findings.candidate) {
        findings.candidate = buildSeqScanCandidate(node);
      }
    }

    if (nodeType === "Sort") {
      findings.hasSort = true;
      if (!findings.candidate) {
        findings.candidate = buildSortCandidate(node);
      }
    }

    if (!findings.candidate && (node["Hash Cond"] || node["Merge Cond"] || node["Join Filter"])) {
      findings.candidate = buildJoinCandidate(node);
    }
  });

  return findings;
}

export function detectPrimaryProblem(findings) {
  if (findings.candidate?.type === "trigram") {
    return "Leading wildcard LIKE forces full scan";
  }
  if (findings.hasSeqScan) {
    return "Database is scanning entire table (no index found), causing slow performance";
  }
  if (findings.hasSort) {
    return "Expensive sort operation";
  }
  return "No clear optimization found";
}
