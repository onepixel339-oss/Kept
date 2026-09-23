/**
 * Document extractor (Phase 9 §10–13) — the only place that knows how
 * a file becomes a normalized ingestion.
 *
 * Supported formats — each verified to work in THIS environment before
 * it was added (spec §10), all extracted locally and deterministically
 * (spec §33 — no AI, no paid dependency):
 *   - .txt / .md   direct bounded read
 *   - .pdf         pdf-parse (open source, MIT) behind the lib entry
 *   - .docx        a minimal ZIP reader (zlib inflate) + XML text strip
 *
 * The original file is preserved BEFORE extraction (spec §11, §36) —
 * extraction can fail, retry, and never lose the only copy. Text
 * output is bounded; a document longer than the bound extracts as
 * `partial` with an honest warning (spec §12).
 */

import * as zlib from "node:zlib";
import { DOCUMENT_LIMITS, MAX_FILE_BYTES } from "@/config/ingestion";
import { buildStorageKey, getStorage } from "@/lib/storage";
import {
  assertUploadSize,
  detectDocumentKind,
  safeDisplayName,
  type UploadFile,
} from "../domain/validation";
import { pdfText } from "./pdf-text";
import { clampText, type NormalizedIngestion } from "../domain/ingestion-types";

const UNSUPPORTED =
  "That file type isn't supported yet — text, Markdown, PDF, and DOCX work. The file was not kept.";
const NO_TEXT_PDF = "No readable text layer was found in that PDF — it may be a scan of images. The file is kept.";
const EXTRACTION_FAILED = "That file couldn't be read just now — it is kept, and you can retry.";
const EXTRACTION_TIMEOUT = "Reading that file took too long — it is kept, and you can retry.";

/* ——— Minimal ZIP reader (STORED + DEFLATE) — private to this module. ——— */

function zipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    try {
      entries.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch {
      // Unreadable entry stays absent — the caller decides honestly.
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&");
}

/** PDF text comes from the local bounded extractor (pdf-text.ts). */
async function pdfTextExtract(bytes: Buffer): Promise<string | null> {
  return pdfText(bytes).text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("__timeout__")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function docxText(bytes: Buffer): string | null {
  const entries = zipEntries(bytes);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) return null;
  return xmlToText(documentXml.toString("utf8"));
}

export async function extractFromDocument(userId: string, file: UploadFile): Promise<NormalizedIngestion> {
  const warnings: NormalizedIngestion["warnings"] = [];
  const label = safeDisplayName(file.name);
  const extension = extensionOf(label);

  try {
    assertUploadSize(file.bytes, MAX_FILE_BYTES);
  } catch (error) {
    return failed(label, error instanceof Error ? error.message : "That file is too large.", warnings, false);
  }

  const kind = detectDocumentKind(file.bytes, extension);
  if (!kind) {
    return failed(label, UNSUPPORTED, warnings, false);
  }

  // Preserve the original BEFORE extraction (spec §36: never lose the
  // only copy because extraction failed).
  const storage = getStorage();
  let originalKey: string | null = null;
  try {
    originalKey = buildStorageKey(userId, extension.replace(".", "") || kind);
    await storage.put(originalKey, file.bytes);
  } catch {
    return failed(label, "The file couldn't be stored — nothing was lost, please try again.", warnings, false);
  }

  let text = "";
  try {
    if (kind === "txt" || kind === "md") {
      text = file.bytes.toString("utf8").replace(/^\uFEFF/, "");
    } else if (kind === "pdf") {
      const extracted = await withTimeout(
        Promise.resolve(pdfTextExtract(file.bytes)),
        DOCUMENT_LIMITS.extractionTimeoutMs
      );
      if (extracted === null) {
        return failed(label, NO_TEXT_PDF, warnings, true, originalKey, kind);
      }
      text = extracted;
    } else {
      const extracted = await withTimeout(
        Promise.resolve(docxText(file.bytes)),
        DOCUMENT_LIMITS.extractionTimeoutMs
      );
      if (extracted === null) {
        return failed(label, EXTRACTION_FAILED, warnings, true, originalKey, kind);
      }
      text = extracted;
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "__timeout__";
    return failed(
      label,
      timedOut ? EXTRACTION_TIMEOUT : EXTRACTION_FAILED,
      warnings,
      true,
      originalKey,
      kind
    );
  }

  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === "") {
    // A scanned PDF (or an empty document) yields no text honestly.
    return failed(label, kind === "pdf" ? NO_TEXT_PDF : EXTRACTION_FAILED, warnings, true, originalKey, kind);
  }

  const bounded = clampText(cleaned, DOCUMENT_LIMITS.maxTextChars);
  if (bounded.truncated) {
    warnings.push({
      code: "document_truncated",
      message: "Only the first part of that document was kept — it is longer than the reading limit.",
    });
    return {
      sourceType: "file",
      status: "partial",
      extractedContent: bounded.text,
      description: null,
      label,
      originalKey,
      thumbnailKey: null,
      url: null,
      mimeType: kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
      sizeBytes: file.bytes.length,
      error: null,
      warnings,
      metadata: documentMetadata(originalKey, label, kind),
    };
  }

  return {
    sourceType: "file",
    status: "ready",
    extractedContent: bounded.text,
    description: null,
    label,
    originalKey,
    thumbnailKey: null,
    url: null,
    mimeType: kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
    sizeBytes: file.bytes.length,
    error: null,
    warnings,
    metadata: documentMetadata(originalKey, label, kind),
  };
}

function extensionOf(label: string): string {
  const dot = label.lastIndexOf(".");
  if (dot <= 0) return "";
  return label.slice(dot).toLowerCase();
}

function documentMetadata(originalKey: string, label: string, kind: string): Record<string, unknown> {
  return {
    storageKey: originalKey,
    originalFilename: label,
    documentKind: kind,
    extractionTool: kind === "pdf" ? "pdf-operators" : kind === "docx" ? "zip-xml" : "utf8",
  };
}

function failed(
  label: string,
  message: string,
  warnings: NormalizedIngestion["warnings"],
  preserved: boolean,
  originalKey: string | null = null,
  kind: string | null = null
): NormalizedIngestion {
  return {
    sourceType: "file",
    status: "failed",
    extractedContent: null,
    description: null,
    label,
    originalKey: preserved ? originalKey : null,
    thumbnailKey: null,
    url: null,
    mimeType: null,
    sizeBytes: null,
    error: message,
    warnings,
    metadata: {
      originalFilename: label,
      ...(preserved && originalKey ? { storageKey: originalKey } : {}),
      ...(kind ? { documentKind: kind } : {}),
    },
  };
}
