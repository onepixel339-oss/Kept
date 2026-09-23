/**
 * Bounded HTML → readable text (Phase 9 §16).
 *
 * The parser is deliberately simple and isolated: it never executes
 * anything, never fetches anything, and cannot grow past its bound.
 * It exists to answer one question — what does this page SAY — well
 * enough for a personal memory, not to win a readability contest.
 */

/** Blocks that never contribute text. */
const STRIPPED_BLOCKS =
  /<(script|style|noscript|template|svg|head|iframe|object|embed|form|button|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Self-contained noise. */
const STRIPPED_VOID = /<(script|style|link|meta|input|img|picture|source|video|audio|canvas)\b[^>]*\/?>/gi;

/** Block-level closers become line breaks; cells become spaces. */
const BLOCK_BREAKS = /<\/(p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|blockquote|pre|figcaption)>/gi;
const CELL_BREAKS = /<\/(td|th)>/gi;
const LINE_BREAKS = /<br\s*\/?>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  laquo: "«",
  raquo: "»",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export interface HtmlTextResult {
  text: string;
  truncated: boolean;
}

/**
 * Extract bounded readable text from an HTML document.
 * Input is whatever was fetched (capped upstream); output is capped here.
 */
export function htmlToText(html: string, maxChars: number): HtmlTextResult {
  let working = html.slice(0, Math.max(maxChars * 8, 64_000)); // bound the work itself

  working = working
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(STRIPPED_BLOCKS, " ")
    .replace(STRIPPED_VOID, " ")
    .replace(LINE_BREAKS, "\n")
    .replace(BLOCK_BREAKS, "\n")
    .replace(CELL_BREAKS, " ")
    .replace(/<[^>]+>/g, " ");

  working = decodeEntities(working);

  const lines = working
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0);

  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars).replace(/\s+\S*$/, "");
  }
  return { text, truncated };
}

/** Extract <title> without executing anything. */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : null;
}
