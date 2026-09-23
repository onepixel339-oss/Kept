/**
 * Deterministic time resolution — the system's own clock math.
 *
 * Resolves temporal expressions from the user's question into honest
 * windows. This module is the AUTHORITY on dates: when the AI
 * proposes a relative window, its expression is re-resolved here; the
 * deterministic fallback uses it directly. Uncertainty is part of the
 * result — an assumed year or an assumed month is marked uncertain,
 * never silently promoted to fact.
 *
 * Supported (v1, documented in docs/query-system.md):
 *  - relative rolling windows: last N days/weeks/months/years
 *    (English + Egyptian Arabic: "آخر شهر", "الشهر اللي فات", "امبارح")
 *  - named calendar months (English + Arabic), most recent past
 *    occurrence, uncertain when the year was assumed
 *  - seasons (summer/winter/… + صيف/شتاء/…), same assumption rule
 *  - explicit years (19xx/20xx, Arabic-Indic digits included)
 *  - ISO dates (YYYY-MM-DD)
 *
 * Anything else returns null — "I could not resolve this" — and the
 * caller preserves the raw words as an uncertainty instead of
 * pretending a date.
 */

export interface ResolvedTimeWindow {
  kind: "exact" | "range" | "month" | "year" | "relative";
  from: Date | null;
  to: Date | null;
  uncertain: boolean;
}

/** Arabic-Indic digits → ASCII, so "٢٠٢٤" and "2024" behave alike. */
function normalizeDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function monthWindow(year: number, monthIndex: number, now: Date): { from: Date; to: Date } | null {
  const from = new Date(year, monthIndex, 1);
  const to = endOfDay(new Date(year, monthIndex + 1, 0));
  if (from > now) return null; // a future month has no memories yet
  return { from, to };
}

/** name, month index, latin? (Latin names get \b boundaries; Arabic gets prefix forms) */
const MONTHS: Array<[string, number, boolean]> = [
  ["january", 0, true], ["february", 1, true], ["march", 2, true], ["april", 3, true],
  ["may", 4, true], ["june", 5, true], ["july", 6, true], ["august", 7, true],
  ["september", 8, true], ["october", 9, true], ["november", 10, true], ["december", 11, true],
  ["jan", 0, true], ["feb", 1, true], ["mar", 2, true], ["apr", 3, true],
  ["jun", 5, true], ["jul", 6, true], ["aug", 7, true], ["sep", 8, true],
  ["sept", 8, true], ["oct", 9, true], ["nov", 10, true], ["dec", 11, true],
  ["يناير", 0, false], ["فبراير", 1, false], ["مارس", 2, false], ["أبريل", 3, false],
  ["ابريل", 3, false], ["مايو", 4, false], ["يونيو", 5, false], ["يوليو", 6, false],
  ["يوليه", 6, false], ["أغسطس", 7, false], ["اغسطس", 7, false], ["سبتمبر", 8, false],
  ["أكتوبر", 9, false], ["اكتوبر", 9, false], ["نوفمبر", 10, false], ["ديسمبر", 11, false],
];

const SEASONS: Array<[string, number[], boolean]> = [
  ["summer", [5, 6, 7], true], // Jun–Aug
  ["winter", [11, 0, 1], true], // Dec–Feb
  ["spring", [2, 3, 4], true], // Mar–May
  ["autumn", [8, 9, 10], true], // Sep–Nov
  ["fall", [8, 9, 10], true],
  ["صيف", [5, 6, 7], false],
  ["شتاء", [11, 0, 1], false],
  ["ربيع", [2, 3, 4], false],
  ["خريف", [8, 9, 10], false],
];

/** The most recent past occurrence of a season, respecting wrap-around years. */
function seasonWindow(months: number[], now: Date): ResolvedTimeWindow {
  const thisYear = now.getFullYear();
  const indices = [...months].sort((a, b) => a - b);
  const startMonth = indices[0];
  const endMonth = indices[indices.length - 1];
  const candidates: Array<{ from: Date; to: Date }> = [];
  for (const year of [thisYear, thisYear - 1]) {
    // Winter wraps across the year boundary: Dec(year-1)–Feb(year).
    const startYear = startMonth > endMonth ? year - 1 : year;
    const from = new Date(startYear, startMonth, 1);
    const to = endOfDay(new Date(year, endMonth + 1, 0));
    candidates.push({ from, to });
  }
  const past = candidates
    .filter((c) => c.from <= now)
    .sort((a, b) => b.from.getTime() - a.from.getTime());
  const chosen = past[0] ?? candidates[candidates.length - 1];
  return { kind: "range", from: chosen.from, to: chosen.to, uncertain: true };
}

function rollingWindow(n: number, unit: "day" | "week" | "month" | "year", now: Date): ResolvedTimeWindow {
  const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
  const from = startOfDay(new Date(now.getTime() - days * DAY));
  // A rolling window ends "now", not at midnight — memories kept today count.
  return { kind: "relative", from, to: endOfDay(now), uncertain: false };
}

function arabicUnit(unit: string): "day" | "week" | "month" | "year" {
  if (unit.includes("يوم")) return "day";
  if (unit.includes("سبوع")) return "week";
  if (unit.includes("شهر")) return "month";
  return "year";
}

/** Post-process a resolved window into the shared time-range shape (ISO strings). */
export function normalizeResolvedWindow(
  resolved: ResolvedTimeWindow,
  expression: string | null
): {
  kind: ResolvedTimeWindow["kind"];
  from: string | null;
  to: string | null;
  expression: string | null;
  uncertain: boolean;
} {
  return {
    kind: resolved.kind,
    from: resolved.from ? resolved.from.toISOString() : null,
    to: resolved.to ? resolved.to.toISOString() : null,
    expression,
    uncertain: resolved.uncertain,
  };
}

/**
 * Resolve one temporal expression. Returns null when nothing usable
 * is found — callers preserve uncertainty instead of guessing.
 */
export function resolveTimeExpression(
  input: string,
  now: Date,
  _timezone: string
): ResolvedTimeWindow | null {
  const text = normalizeDigits(input).toLowerCase();

  // ——— ISO / explicit dates ———
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const from = startOfDay(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (!Number.isNaN(from.getTime())) {
      return { kind: "exact", from, to: endOfDay(from), uncertain: false };
    }
  }

  // ——— Explicit years: "in 2024", "عام ٢٠٢٣" ———
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = Number(yearMatch[0]);
    const from = new Date(year, 0, 1);
    const to = endOfDay(new Date(year, 11, 31));
    if (from <= now) {
      return { kind: "year", from, to, uncertain: false };
    }
  }

  // ——— Point references: today / yesterday ———
  if (/اليوم|today/.test(text)) {
    return { kind: "relative", from: startOfDay(now), to: endOfDay(now), uncertain: false };
  }
  if (/امبارح|أمبارح|أمس|yesterday/.test(text)) {
    const from = startOfDay(new Date(now.getTime() - DAY));
    return { kind: "relative", from, to: endOfDay(from), uncertain: false };
  }

  // ——— Relative rolling windows ———
  // English: "last 3 months", "in the past week"
  let m = text.match(/(?:in\s+the\s+)?(?:last|past)\s+(\d+)\s*(day|week|month|year)s?\b/);
  if (m) {
    return rollingWindow(Math.min(Number(m[1]), 365), m[2] as "day" | "week" | "month" | "year", now);
  }
  m = text.match(/\b(?:last|past|this)\s+(day|week|month|year)\b/);
  if (m) {
    return rollingWindow(1, m[1] as "day" | "week" | "month" | "year", now);
  }
  // Arabic: "آخر شهر", "آخر ٣ أشهر"
  m = text.match(/آخر\s*(\d+)?\s*(يومين|أيام|يوم|أسابيع|أسبوع|اسبوع|شهور|أشهر|شهر|سنوات|سنة|عام)/);
  if (m) {
    const n = m[1] ? Math.min(Number(m[1]), 365) : 1;
    return rollingWindow(n, arabicUnit(m[2]), now);
  }
  // Arabic: "الشهر اللي فات", "الاسبوع الماضي", "السنة اللي فات"
  m = text.match(/(الأسبوع|الاسبوع|الشهر|السنة|العام)\s*(اللي\s*فات|الماضي|الماضية|الماضي|الفات)/);
  if (m) {
    const window = rollingWindow(1, arabicUnit(m[1]), now);
    // An interpretation choice (rolling vs previous calendar unit) — honest about it.
    return { ...window, uncertain: true };
  }

  // ——— Seasons: "الصيف اللي فات", "last summer" ———
  for (const [name, months, latin] of SEASONS) {
    const pattern = latin ? new RegExp(`(^|\\s)${name}\\b`) : new RegExp(`(^|\\s|ال)${name}`);
    if (pattern.test(text)) {
      return seasonWindow(months, now);
    }
  }

  // ——— Named months: "أغسطس", "in august" ———
  for (const [name, monthIndex, latin] of MONTHS) {
    const pattern = latin ? new RegExp(`(^|\\s)${name}\\b`) : new RegExp(`(^|\\s|ال)${name}`);
    if (pattern.test(text)) {
      const currentYear = now.getFullYear();
      const assumed = monthWindow(currentYear, monthIndex, now);
      if (assumed) {
        // This year's occurrence is already past — the reference is
        // unambiguous ("أغسطس" in September means this year's August).
        return { kind: "month", from: assumed.from, to: assumed.to, uncertain: false };
      }
      const previous = monthWindow(currentYear - 1, monthIndex, now);
      if (previous) {
        // The month had already passed this year, so "أغسطس" most
        // likely meant LAST August — the year was assumed.
        return { kind: "month", from: previous.from, to: previous.to, uncertain: true };
      }
    }
  }

  return null;
}
