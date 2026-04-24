import { Client } from "pg";

import { TOP_QUERY_LIMIT } from "./constants.js";

export async function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const client = new Client({
    connectionString,
    statement_timeout: 30_000
  });

  await client.connect();
  return client;
}

export async function fetchSlowQueries(client, limit = TOP_QUERY_LIMIT) {
  const meanThreshold = Number(process.env.QUERYDOCTOR_THRESHOLD || 5);
  const totalThreshold = Number(process.env.QUERYDOCTOR_TOTAL_THRESHOLD || 50);
  const sql = `
    SELECT query, total_exec_time AS total_time, mean_exec_time AS mean_time, calls, rows
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_catalog%'
      AND query NOT ILIKE '%pg_stat_statements%'
      AND query NOT ILIKE '%pg_catalog.%'
      AND query NOT ILIKE '%information_schema.%'
      AND query NOT ILIKE '%information_schema%'
      AND (
        mean_exec_time > $1
        OR total_exec_time > $2
        OR calls > 5
      )
    ORDER BY total_exec_time DESC
    LIMIT $3;
  `;

  const result = await client.query(sql, [meanThreshold, totalThreshold, limit]);
  if (result.rows.length > 0) {
    return result.rows;
  }

  // Fallback path for local/dev environments where strict filters over-prune.
  console.log("Using fallback query due to strict filtering");
  const fallbackSql = `
    SELECT query, calls, total_exec_time AS total_time, mean_exec_time AS mean_time, rows
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_catalog%'
    ORDER BY total_exec_time DESC
    LIMIT 1;
  `;
  const fallbackResult = await client.query(fallbackSql);
  return fallbackResult.rows;
}

export async function explainJson(client, queryText) {
  const explainSql = `EXPLAIN (FORMAT JSON) ${queryText}`;
  const result = await client.query(explainSql);
  return result.rows[0]["QUERY PLAN"][0];
}

export async function ensureHypoPg(client) {
  // Detect installed extension state only; do not attempt installation.
  const result = await client.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'hypopg' LIMIT 1;"
  );
  return result.rowCount > 0;
}

export async function createHypotheticalIndex(client, indexSql) {
  if (!indexSql || typeof indexSql !== "string") {
    return null;
  }
  // Normalize SQL to avoid duplicate hypothetical indexes with spacing/case differences.
  const normalizeIndexSql = (sql) =>
    String(sql)
      .trim()
      .replace(/;$/, "")
      .replace(/\s+/g, " ")
      .toLowerCase();

  const normalizedSql = normalizeIndexSql(indexSql);
  const existing = await client.query("SELECT indexdef FROM hypopg_list_indexes;");
  const duplicate = existing.rows.some((row) => {
    const def = normalizeIndexSql(row.indexdef || "");
    return def === normalizedSql;
  });

  if (duplicate) {
    // Deterministic behavior: skip duplicate hypothetical index creation.
    return null;
  }

  try {
    const result = await client.query("SELECT * FROM hypopg_create_index($1);", [indexSql]);
    return result.rows[0];
  } catch {
    // Gracefully continue when hypothetical index creation is not possible.
    return null;
  }
}

export async function resetHypotheticalIndexes(client) {
  await client.query("SELECT hypopg_reset();");
}
