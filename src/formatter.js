import { toPercent } from "./utils.js";

function divider() {
  return "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
}

function getConfidenceReason(diagnosis) {
  if (diagnosis.confidence === "HIGH") {
    if (diagnosis.recommendation?.table && diagnosis.recommendation?.column) {
      return "clear missing index detected";
    }
    return "strong optimization signal found";
  }
  if (diagnosis.confidence === "MEDIUM") {
    return "moderate estimated improvement";
  }
  return "limited measurable improvement";
}

export function renderDiagnosis(diagnosis) {
  const lines = [];
  const rec = diagnosis.recommendation;
  const table = rec?.table;
  const column = rec?.column;
  const fixSql = rec?.fixSQL || rec?.sql || "No safe index recommendation could be generated";
  const isLowConfidence = diagnosis.confidence === "LOW";
  const isLikeTrigram = rec?.type === "trigram";
  let problemLine = diagnosis.triggerMessage
    ? `${diagnosis.triggerMessage}. ${diagnosis.primaryProblem}`
    : diagnosis.primaryProblem;
  // Grammar/clarity guard for full-scan messaging with concrete column when available.
  if (problemLine.toLowerCase().includes("scanning entire table")) {
    problemLine = column
      ? `This query performs a full table scan due to a missing index on ${column}.`
      : "This query performs a full table scan due to a missing index.";
  }
  const hasMeasuredImpact =
    typeof diagnosis.beforeCost === "number" &&
    typeof diagnosis.afterCost === "number" &&
    diagnosis.beforeCost > 0 &&
    diagnosis.afterCost > 0 &&
    diagnosis.beforeCost !== diagnosis.afterCost;

  lines.push(divider());
  lines.push("🚨 ROOT CAUSE IDENTIFIED");
  lines.push(divider());
  lines.push("");
  lines.push("📌 Query");
  lines.push(diagnosis.queryText);
  lines.push("");
  lines.push("⚠️ Problem");
  lines.push(problemLine);
  if (isLikeTrigram) {
    lines.push("Standard B-tree indexes do not optimize leading wildcard LIKE queries.");
  }
  if (diagnosis.nPlusOne) {
    lines.push("Possible N+1 query detected from application layer");
  }
  lines.push("");
  lines.push("📉 Impact");
  if (hasMeasuredImpact) {
    lines.push(`Before Cost: ${diagnosis.beforeCost?.toFixed(2) ?? "n/a"}`);
    lines.push(`After Cost: ${diagnosis.afterCost?.toFixed(2) ?? "n/a"}`);
    lines.push(`Speedup: ${toPercent(diagnosis.improvement)}`);
  } else {
    lines.push("Estimated Impact: Query expected to be significantly faster after indexing.");
  }
  lines.push("");
  lines.push(divider());
  lines.push("");
  lines.push("🧠 ROOT CAUSE");
  lines.push(divider());
  lines.push("");
  lines.push(diagnosis.rootCause || "No clear root cause could be derived from available metadata.");
  lines.push("");
  lines.push("👉 Fix in code:");
  if (table && column) {
    lines.push(`- Add index on ${table}.${column}`);
    lines.push(`- Ensure queries using this column leverage the index`);
  } else {
    lines.push("- Add index on the detected filter/sort column");
    lines.push("- Ensure queries using this column leverage the index");
  }
  lines.push("");
  lines.push(divider());
  lines.push("");
  lines.push("💡 Recommended Fix");
  lines.push(fixSql);
  lines.push("");
  lines.push(divider());
  lines.push("");

  lines.push("⚖️ Trade-offs");
  lines.push("+ Faster reads");
  lines.push("- Slight write overhead");
  lines.push("- Additional storage usage");
  lines.push("");
  lines.push(divider());
  lines.push("");

  lines.push(`🔥 Confidence: ${diagnosis.confidence} (${getConfidenceReason(diagnosis)})`);
  if (isLowConfidence) {
    lines.push("");
    lines.push("⚠️ Note: Performance improvement is minimal; consider alternative optimizations");
  }
  lines.push("");
  lines.push(divider());

  return lines.join("\n");
}
