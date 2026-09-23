/**
 * Bounded PDF text extraction (Phase 9 §10–12) — local, deterministic,
 * dependency-free.
 *
 * Approach: scan the raw bytes for content streams (plain and
 * FlateDecode-compressed), inflate them, and read the text-showing
 * operators (Tj, TJ, ') — nothing else. This is deliberately NOT a
 * full PDF interpreter: complex encodings (CID/CJK fonts) and scanned
 * pages honestly yield "no readable text" instead of garbage — the
 * source is preserved and the state reflects reality (spec §11, §16).
 *
 * Every step is bounded: stream count, bytes inflated, text kept.
 */

import * as zlib from "node:zlib";
import { DOCUMENT_LIMITS } from "@/config/ingestion";

const MAX_STREAMS = 64; // bounded work per document
const MAX_INFLATED = 4 * 1024 * 1024; // bounded bytes per content stream

export interface PdfTextResult {
  text: string | null;
  /** True when at least one content stream was readable but had no text operators. */
  hadContentStreams: boolean;
}

/** Extract readable text from a PDF buffer, or null when none can be read honestly. */
export function pdfText(bytes: Buffer): PdfTextResult {
  const streams = findStreams(bytes);
  if (streams.length === 0) return { text: null, hadContentStreams: false };

  const pieces: string[] = [];
  let streamsRead = 0;
  for (const stream of streams.slice(0, MAX_STREAMS)) {
    const content = inflateStream(stream);
    if (process.env.PDF_DEBUG) {
      console.error(
        "[pdf-debug] stream dict tail:", stream.dictionary.slice(-60).replace(/\n/g, " "),
        "| inflated:", content ? content.length : "null"
      );
    }
    if (content === null) continue;
    streamsRead += 1;
    const operators = extractTextOperators(content);
    if (operators.trim() !== "") pieces.push(operators.trim());
  }

  if (streamsRead === 0) return { text: null, hadContentStreams: streams.length > 0 };

  const joined = pieces.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (joined === "") return { text: null, hadContentStreams: true };
  if (looksLikeGarbage(joined)) return { text: null, hadContentStreams: true };
  return { text: joined.length > DOCUMENT_LIMITS.maxTextChars ? joined.slice(0, DOCUMENT_LIMITS.maxTextChars) : joined, hadContentStreams: true };
}

interface RawStream {
  dictionary: string;
  data: Buffer;
}

/** Locate `stream ... endstream` ranges with their dictionaries, bounded. */
function findStreams(bytes: Buffer): RawStream[] {
  const streams: RawStream[] = [];
  const keyword = Buffer.from("stream");
  const endKeyword = Buffer.from("endstream");
  let cursor = 0;
  for (;;) {
    const start = bytes.indexOf(keyword, cursor);
    if (start === -1 || streams.length > MAX_STREAMS) break;
    // The dictionary ends just before "stream", skipping its EOL.
    let dictEnd = start;
    if (bytes[dictEnd - 1] === 0x0a) dictEnd -= 1;
    if (bytes[dictEnd - 1] === 0x0d) dictEnd -= 1;
    const dictStart = Math.max(0, bytes.lastIndexOf("<<", dictEnd));
    const dictionary = bytes.subarray(dictStart, dictEnd).toString("latin1");

    let dataStart = start + keyword.length;
    if (bytes[dataStart] === 0x0d) dataStart += 1;
    if (bytes[dataStart] === 0x0a) dataStart += 1;

    const end = bytes.indexOf(endKeyword, dataStart);
    if (end === -1) break;
    let dataEnd = end;
    if (bytes[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (bytes[dataEnd - 1] === 0x0d) dataEnd -= 1;

    streams.push({ dictionary, data: bytes.subarray(dataStart, dataEnd) });
    cursor = end + endKeyword.length;
  }
  return streams;
}

/** Inflate a FlateDecode stream; plain streams pass through. */
function inflateStream(stream: RawStream): Buffer | null {
  const raw = stream.data;
  if (raw.length === 0 || raw.length > MAX_INFLATED * 4) return null;
  const compressed = /\/FlateDecode/.test(stream.dictionary);
  const ascii85 = /\/ASCII85Decode/.test(stream.dictionary);
  if (!compressed && !ascii85) {
    return raw.length <= MAX_INFLATED && isMostlyPrintable(raw.toString("latin1")) ? raw : null;
  }
  // Unwrap ASCII85 first when the filter chain asks for it.
  let payload = raw;
  if (ascii85) {
    const decoded = decodeAscii85(raw);
    if (decoded === null) return null;
    payload = decoded;
    if (!compressed) {
      return payload.length <= MAX_INFLATED && isMostlyPrintable(payload.toString("latin1")) ? payload : null;
    }
  }
  try {
    const inflated = zlib.inflateSync(payload);
    return inflated.length <= MAX_INFLATED ? inflated : null;
  } catch {
    try {
      const inflated = zlib.inflateRawSync(payload);
      return inflated.length <= MAX_INFLATED ? inflated : null;
    } catch {
      return null;
    }
  }
}

/** Decode an ASCII85 (btoa) payload, PDF-style (ends with ~>); null when malformed. */
function decodeAscii85(data: Buffer): Buffer | null {
  let text = data.toString("latin1");
  const tilde = text.indexOf("~");
  if (tilde !== -1) text = text.slice(0, tilde);
  text = text.replace(/\s+/g, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of text) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const value = ch.charCodeAt(0) - 33;
    if (value < 0 || value > 84) return null;
    group.push(value);
    if (group.length === 5) {
      let packed = 0;
      for (const digit of group) packed = packed * 85 + digit;
      out.push((packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff);
      group = [];
    }
  }
  if (group.length > 0) {
    if (group.length === 1) return null;
    for (let i = group.length; i < 5; i++) group.push(84);
    let packed = 0;
    for (const digit of group) packed = packed * 85 + digit;
    const bytes = [(packed >>> 24) & 0xff, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff];
    out.push(...bytes.slice(0, group.length - 1));
  }
  return Buffer.from(out);
}

/**
 * Read the text-showing operators from one content stream.
 * Handles (…) strings with escapes, TJ arrays, and line-break-ish
 * operators. Everything else is ignored.
 */
function extractTextOperators(content: Buffer): string {
  const source = content.toString("latin1");
  let out = "";
  let i = 0;
  let lastOperator = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") {
      const [literal, next] = readLiteralString(source, i);
      out += literal;
      i = next;
      continue;
    }
    if (ch === "[" || ch === "]") {
      i += 1;
      continue;
    }
    // Operators and numbers — watch for line-breaking commands.
    if (ch === "T" && source[i + 1] === "j") {
      lastOperator = "Tj";
      out += "\u0000";
      i += 2;
      continue;
    }
    if (ch === "'" || (ch === "T" && source[i + 1] === "*")) {
      out += "\n";
      i += ch === "'" ? 1 : 2;
      continue;
    }
    if (ch === "T" && source[i + 1] === "D") {
      out += "\n";
      i += 2;
      continue;
    }
    if (ch === "T" && source[i + 1] === "d") {
      // Positioning without a line break is just a space boundary.
      out += "\u0000";
      i += 2;
      continue;
    }
    if (ch === "E" && source.slice(i, i + 2) === "ET") {
      out += "\n";
      i += 2;
      continue;
    }
    if (ch === "\\" && out.length > 0 && lastOperator === "") {
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Numbers, names, everything else — skip token chars.
    i += 1;
  }
  return out
    .split("\u0000")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ")
    .replace(/\n{3,}/g, "\n\n");
}

/** Read a PDF literal string starting at `(`, honoring escapes and nesting. */
function readLiteralString(source: string, start: number): [string, number] {
  let depth = 1;
  let i = start + 1;
  let out = "";
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "b" || next === "f") out += " ";
      else if (next >= "0" && next <= "7") {
        // Octal escape — up to three digits.
        let value = 0;
        let digits = 0;
        let j = i + 1;
        while (j < source.length && digits < 3 && source[j] >= "0" && source[j] <= "7") {
          value = value * 8 + (source.charCodeAt(j) - 48);
          j += 1;
          digits += 1;
        }
        out += String.fromCharCode(value);
        i = j;
        continue;
      } else out += next ?? "";
      i += 2;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    out += ch;
    i += 1;
  }
  return [decodePdfString(out), i + 1];
}

/**
 * PDF text strings are PDFDocEncoding (close to latin1 for the
 * printable ASCII range). Anything outside readable form is dropped —
 * garbage is never shown as content.
 */
function decodePdfString(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      out += ch;
    } else {
      out += " ";
    }
  }
  return out;
}

function isMostlyPrintable(text: string): boolean {
  if (text.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) printable += 1;
  }
  return printable / text.length > 0.8;
}

/** Guard against CID/CJK garbage: mostly non-ASCII noise is not "text". */
function looksLikeGarbage(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (sample.length === 0) return true;
  const ascii = sample.split("").filter((ch) => ch.charCodeAt(0) < 128).length;
  return ascii / sample.length < 0.5;
}
