/**
 * Minimal line diff for inline previews (approval cards, run summaries).
 *
 * LCS over lines, trimmed to hunks with a little context. Not a replacement
 * for Monaco's DiffEditor — this is for a dozen lines in a card, where
 * loading an editor would be absurd.
 */

export type DiffLine =
  | { kind: "same"; text: string; a: number; b: number }
  | { kind: "add"; text: string; b: number }
  | { kind: "del"; text: string; a: number }
  | { kind: "gap"; hidden: number };

/** Above this many lines per side we skip LCS and show a whole replace. */
const MAX_LINES = 1500;

export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text, i) => ({ kind: "del" as const, text, a: i + 1 })),
      ...b.map((text, i) => ({ kind: "add" as const, text, b: i + 1 })),
    ];
  }
  // Trim the common prefix and suffix first; LCS only the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ kind: "same", text: a[i], a: i + 1, b: i + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i], a: start + i + 1, b: start + j + 1 });
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
      out.push({ kind: "add", text: midB[j], b: start + j + 1 });
      j += 1;
    } else {
      out.push({ kind: "del", text: midA[i], a: start + i + 1 });
      i += 1;
    }
  }
  for (let k = 0; k < a.length - endA; k += 1) {
    out.push({ kind: "same", text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  }
  return out;
}

/** Collapse unchanged runs longer than `2 * context` into a gap marker. */
export function withContext(lines: DiffLine[], context = 2): DiffLine[] {
  const changed = lines.map((l) => l.kind === "add" || l.kind === "del");
  const keep = lines.map((_, index) => {
    for (let d = -context; d <= context; d += 1) {
      if (changed[index + d]) return true;
    }
    return false;
  });
  const out: DiffLine[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(line);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) out.push({ kind: "gap", hidden });
  return out;
}
