export function sanitizeQuery(queryText) {
  const source = String(queryText || "");
  const replaced = source.replace(/\$(\d+)/g, (paramRef, _num, offset) => {
    const before = source.slice(Math.max(0, offset - 40), offset);
    const after = source.slice(offset + paramRef.length, offset + paramRef.length + 40);
    const context = `${before} ${after}`.toUpperCase();

    // Keep LIMIT/OFFSET executable and meaningful with bounded numeric values.
    if (/\b(LIMIT|OFFSET)\s*$/.test(before.toUpperCase())) {
      return "10";
    }
    // Numeric comparators should get numeric literals.
    if (/[<>=]\s*$/.test(before) || /\b(BETWEEN|IN)\b/.test(context)) {
      return "1";
    }
    // LIKE/ILIKE placeholders should remain text and useful for pattern analysis.
    if (/\b(LIKE|ILIKE)\s*$/.test(before.toUpperCase())) {
      return "'test'";
    }
    // Deterministic string fallback instead of NULL to preserve SQL semantics.
    return "'value'";
  });

  return replaced
    .replace(/\btrue\b/gi, "TRUE")
    .replace(/\bfalse\b/gi, "FALSE")
    .trim();
}

export function toPercent(value) {
  return `${Math.max(0, Math.round(value))}%`;
}

export function formatDurationMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "n/a";
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  return Intl.NumberFormat("en-US").format(Math.round(value));
}
