#!/usr/bin/env node

import chalk from "chalk";
import { Command } from "commander";

import {
  createClient,
  ensureHypoPg,
  explainJson,
  fetchSlowQueries,
  createHypotheticalIndex,
  resetHypotheticalIndexes
} from "./db.js";
import { buildDiagnosis } from "./decisionEngine.js";
import { renderDiagnosis } from "./formatter.js";
import { sanitizeQuery } from "./utils.js";

const MAX_ANALYZED_QUERIES = 3;
const SQL_FETCH_LIMIT = 5;

function normalizeQueryText(queryText) {
  return String(queryText || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getImpactScore(queryStat) {
  const totalExecTime = Number(queryStat.total_time) || 0;
  const meanExecTime = Number(queryStat.mean_time) || 0;
  const calls = Number(queryStat.calls) || 0;
  const avgTime = meanExecTime > 0 ? meanExecTime : calls > 0 ? totalExecTime / calls : 0;
  // Deterministic impact metric: favor heavy cumulative DB time.
  return Math.max(totalExecTime, calls * avgTime);
}

function getTopImpactQueries(slowQueries) {
  return [...slowQueries]
    .map((queryStat) => ({
      ...queryStat,
      impactScore: getImpactScore(queryStat)
    }))
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, MAX_ANALYZED_QUERIES);
}

function isValidQueryShape(queryText) {
  if (!queryText || queryText.length < 10) return false;
  // Keep simple deterministic SQL shape validation.
  return /^(select|update|delete|insert|with)\b/i.test(queryText);
}

function validateSlowQueries(slowQueries) {
  return slowQueries.filter((queryStat) => {
    const normalized = normalizeQueryText(queryStat.query);
    const hasInvalidControlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalized);
    if (!isValidQueryShape(normalized)) return false;
    // Validation is intentionally lightweight: reject only malformed/system-looking query text.
    if (hasInvalidControlChars) return false;
    if (/pg_catalog|pg_stat_statements|information_schema/i.test(normalized)) return false;
    return true;
  });
}

function buildPrimarySummary(diagnosis) {
  const recommendation = diagnosis.recommendation;
  const table = recommendation?.table;
  const column = recommendation?.column;
  if (table && column) {
    return `Your application is slowed by a full table scan on ${table} due to a missing index on ${column}.`;
  }
  return diagnosis.primaryProblem || "No clear optimization found.";
}

function printPrimaryIssue(diagnosis) {
  const divider = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
  const fixSql =
    diagnosis.recommendation?.fixSQL ||
    diagnosis.recommendation?.sql ||
    "No safe index recommendation could be generated";
  const why = diagnosis.rootCause || buildPrimarySummary(diagnosis);
  console.log(chalk.red(divider));
  console.log(chalk.red("🚨 PRIMARY ISSUE"));
  console.log(chalk.red(divider));
  console.log("");
  console.log("Problem:");
  console.log(buildPrimarySummary(diagnosis));
  console.log("");
  console.log("Action:");
  console.log(fixSql);
  console.log("");
  console.log("Why:");
  console.log(why);
  console.log("");
}

function resolveDatabaseUrl(cliDb) {
  return cliDb || process.env.DATABASE_URL || null;
}

async function runDiagnosis(dbUrl) {
  // Keep existing DB layer behavior; CLI flag takes precedence.
  process.env.DATABASE_URL = dbUrl;

  console.log("🔍 Analyzing database...");
  const client = await createClient();
  try {
    const slowQueries = await fetchSlowQueries(client, SQL_FETCH_LIMIT);
    if (!slowQueries.length) {
      console.log(chalk.green("✅ No major performance issues detected"));
      console.log("Your database queries look healthy.");
      return;
    }

    let hypopgAvailable = false;
    try {
      hypopgAvailable = await ensureHypoPg(client);
    } catch {
      // Safety fallback: treat missing/unreadable extension metadata as unavailable.
      hypopgAvailable = false;
    }

    const validatedQueries = validateSlowQueries(slowQueries);
    const candidateQueries = validatedQueries.length ? validatedQueries : [slowQueries[0]];
    if (!validatedQueries.length) {
      console.log("JS validation skipped all queries — using fallback");
    }
    const topImpactQueries = getTopImpactQueries(candidateQueries);
    // Final selection: keep top 1-3 candidates, analyze only the top query.
    const selectedQuery = topImpactQueries[0];
    const collectedDiagnoses = [];
    for (const queryStat of [selectedQuery]) {
      try {
        const sanitized = sanitizeQuery(normalizeQueryText(queryStat.query));
        if (!sanitized || sanitized.length < 10) {
          continue;
        }

        let planBefore;
        try {
          planBefore = await explainJson(client, sanitized);
        } catch {
          // Skip queries that cannot be explained safely after sanitization.
          continue;
        }

        const preDiagnosis = buildDiagnosis({
          queryText: sanitized,
          planBefore,
          planAfter: null,
          stats: queryStat
        });

        let planAfter = null;
        const fixSQL = preDiagnosis.recommendation?.fixSQL || preDiagnosis.recommendation?.sql;
        if (fixSQL && hypopgAvailable) {
          // Safety: clear hypothetical indexes before each simulation.
          try {
            await resetHypotheticalIndexes(client);
          } catch {
            // Non-fatal; continue with simulation attempt.
          }

          try {
            await createHypotheticalIndex(client, fixSQL);
            planAfter = await explainJson(client, sanitized);
          } catch {
            // Keep output deterministic: if simulation fails, we still print diagnosis with before plan.
            planAfter = null;
          } finally {
            // Safety: always clear hypothetical indexes after each simulation attempt.
            try {
              await resetHypotheticalIndexes(client);
            } catch {
              // Non-fatal cleanup failure should not crash the CLI.
            }
          }
        }

        const diagnosis = buildDiagnosis({
          queryText: sanitized,
          planBefore,
          planAfter,
          stats: queryStat
        });

        collectedDiagnoses.push({
          ...diagnosis,
          impactScore: queryStat.impactScore
        });
      } catch {
        // Never crash the CLI due to one statement.
        continue;
      }
    }

    if (!collectedDiagnoses.length) {
      console.log(chalk.green("✅ No major performance issues detected"));
      console.log("Your database queries look healthy.");
      return;
    }

    // Collapse noise: prefer non-LOW confidence; only include LOW when there is no better option.
    const nonLowDiagnoses = collectedDiagnoses.filter((item) => item.confidence !== "LOW");
    const visibleDiagnoses = nonLowDiagnoses.length ? nonLowDiagnoses : [collectedDiagnoses[0]];

    const primaryDiagnosis = visibleDiagnoses[0];
    printPrimaryIssue(primaryDiagnosis);

    for (const diagnosis of visibleDiagnoses) {
      console.log(renderDiagnosis(diagnosis));
      if (!hypopgAvailable) {
        console.log(chalk.yellow("Simulation unavailable (hypopg not installed)"));
      }
      console.log("");
    }
  } finally {
    await client.end();
  }
}

const program = new Command();

program
  .name("querydoctor")
  .description("Diagnose slow PostgreSQL queries and suggest safe fixes.")
  .helpOption("-h, --help", "Display help")
  .addHelpText(
    "after",
    "\nExamples:\n  querydoctor diagnose --db \"postgres://localhost:5432/postgres\"\n  querydoctor"
  );

// Main command flow: explicit diagnose command invokes existing analysis logic.
program
  .command("diagnose")
  .description("Analyze database performance issues")
  .option("--db <connection_string>", "PostgreSQL connection string")
  .action(async (options) => {
    const dbUrl = resolveDatabaseUrl(options.db);
    if (!dbUrl) {
      console.error("Please provide a database connection using --db or DATABASE_URL");
      process.exitCode = 1;
      return;
    }
    try {
      await runDiagnosis(dbUrl);
    } catch (error) {
      console.error("QueryDoctor failed:", error.message);
      process.exitCode = 1;
    }
  });

// Built-in help already works; keep explicit command for requested UX.
program
  .command("help")
  .description("Show usage information")
  .action(() => {
    program.outputHelp();
  });

// Backward compatible default: no command -> diagnose via commander.
if (process.argv.length <= 2) {
  process.argv.push("diagnose");
}

program.parse(process.argv);
