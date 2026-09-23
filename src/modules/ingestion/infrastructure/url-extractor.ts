/**
 * URL extractor (Phase 9 §14–16) — the only place that knows how a
 * public link becomes a normalized ingestion.
 *
 * Security posture (spec §15), enforced in order:
 *   1. scheme whitelist (http/https only — file:, ftp:, data:,
 *      javascript: and friends never pass)
 *   2. standard ports only
 *   3. DNS resolution with EVERY record checked against private /
 *      loopback / link-local / metadata ranges (domain/ssrf.ts)
 *   4. bounded local fetch: timeout, response-size cap, and manual
 *      redirects where EVERY hop re-passes the full validation
 *   5. only readable content types are parsed; the parser never
 *      executes anything and is bounded on both input and output
 *   6. if the local fetch fails, the provider's hosted page reader is
 *      tried — the URL was already validated, so private addresses
 *      never reach any external service either
 *
 * The original URL is the source of truth and is always preserved —
 * on failure the source stays, marked honestly, retryable (spec §16,
 * §36). No summary is ever fabricated.
 */

import { URL_LIMITS } from "@/config/ingestion";
import { getAiGateway } from "@/lib/ai";
import { htmlToText, extractHtmlTitle } from "../domain/html-text";
import { validatePublicHttpUrl, type UrlLookup } from "../domain/ssrf";
import { clampText, type NormalizedIngestion } from "../domain/ingestion-types";

const USER_AGENT = "Kept/1.0 (personal memory archive)";
const READABLE_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/xhtml",
  "text/plain",
];

/**
 * Injectable dependencies — the production default uses the real DNS
 * resolver and the platform fetch. Tests inject both, so the entire
 * SSRF/redirect surface is exercised with zero network access.
 */
export interface UrlExtractorDeps {
  lookup?: UrlLookup;
  fetchImpl?: typeof fetch;
}

export async function extractFromUrl(
  rawUrl: string,
  deps: UrlExtractorDeps = {}
): Promise<NormalizedIngestion> {
  const lookup = deps.lookup;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const warnings: NormalizedIngestion["warnings"] = [];

  // 1–3. Full validation before anything moves.
  const validation = await validatePublicHttpUrl(rawUrl, lookup);
  if (!validation.ok) {
    return failed(rawUrl, validation.reason, warnings);
  }

  // 4. Bounded local fetch with manually validated redirects.
  const fetched = await boundedFetch(validation.url.href, 0, warnings, lookup, fetchImpl);
  let html: string | null = null;
  let title: string | null = null;
  let plainText = false;

  if (fetched) {
    const contentType = (fetched.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!READABLE_CONTENT_TYPES.includes(contentType)) {
      warnings.push({
        code: "unreadable_content_type",
        message: "That link doesn't point at a readable page — nothing was fetched from it again.",
      });
    } else {
      if (contentType === "text/plain") plainText = true;
      const body = await fetched.text();
      if (plainText) {
        html = body;
      } else {
        html = body;
        title = extractHtmlTitle(body);
      }
    }
  }

  // 5–6. Local extraction first; hosted reader as the honest fallback.
  let text: string | null = null;
  if (plainText && html !== null) {
    text = html;
  } else if (html !== null) {
    const parsed = htmlToText(html, URL_LIMITS.maxTextChars);
    text = parsed.text !== "" ? parsed.text : null;
    if (parsed.truncated) {
      warnings.push({ code: "page_truncated", message: "Only the first part of that page was kept." });
    }
  }

  if (text === null || text === "") {
    try {
      const reader = await getAiGateway().readPage({ url: validation.url.href });
      if (reader) {
        const parsed = htmlToText(reader.html, URL_LIMITS.maxTextChars);
        text = parsed.text !== "" ? parsed.text : null;
        title = title ?? reader.title;
        if (parsed.truncated) {
          warnings.push({ code: "page_truncated", message: "Only the first part of that page was kept." });
        }
      }
    } catch {
      // Reader failed — fall through to the honest failure below.
    }
  }

  if (text === null || text === "") {
    return failed(
      rawUrl,
      "That page couldn't be read just now — the link is kept, and you can retry.",
      warnings,
      title
    );
  }

  const bounded = clampText(text, URL_LIMITS.maxTextChars);
  return {
    sourceType: "url",
    status: "ready",
    extractedContent: bounded.text,
    description: null,
    label: title ?? validation.url.hostname,
    originalKey: null,
    thumbnailKey: null,
    url: validation.url.href,
    mimeType: "text/html",
    sizeBytes: null,
    error: null,
    warnings,
    metadata: {
      url: validation.url.href,
      hostname: validation.url.hostname,
      pageTitle: title,
      fetchedVia: "local-fetch",
    },
  };
}

/** One bounded fetch with manual, re-validated redirects. */
async function boundedFetch(
  url: string,
  hop: number,
  warnings: NormalizedIngestion["warnings"],
  lookup?: UrlLookup,
  fetchImpl: typeof fetch = fetch
): Promise<Response | null> {
  if (hop > URL_LIMITS.maxRedirects) {
    warnings.push({ code: "too_many_redirects", message: "That link redirected too many times." });
    return null;
  }

  // Every hop — including the first — re-passes full validation.
  const validation = await validatePublicHttpUrl(url, lookup);
  if (!validation.ok) {
    warnings.push({ code: "redirect_blocked", message: "A redirect from that link was blocked for safety." });
    return null;
  }

  let response: Response;
  try {
    response = await fetchImpl(validation.url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(URL_LIMITS.timeoutMs),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
      },
    });
  } catch {
    return null;
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) return null;
    const next = new URL(location, validation.url).href;
    return boundedFetch(next, hop + 1, warnings, lookup, fetchImpl);
  }

  if (!response.ok) {
    return null;
  }

  // Read with a hard byte cap.
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!buffer || buffer.byteLength > URL_LIMITS.maxResponseBytes) return null;
    return new Response(buffer, { headers: response.headers });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > URL_LIMITS.maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        return new Response(Buffer.concat(chunks), { headers: response.headers });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return new Response(Buffer.concat(chunks), { headers: response.headers });
}

function failed(
  rawUrl: string,
  message: string,
  warnings: NormalizedIngestion["warnings"],
  pageTitle: string | null = null
): NormalizedIngestion {
  let hostname: string | null = null;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    hostname = null;
  }
  return {
    sourceType: "url",
    status: "failed",
    extractedContent: null,
    description: null,
    label: pageTitle ?? hostname,
    originalKey: null,
    thumbnailKey: null,
    url: rawUrl,
    mimeType: null,
    sizeBytes: null,
    error: message,
    warnings,
    metadata: {
      url: rawUrl,
      ...(hostname ? { hostname } : {}),
      ...(pageTitle ? { pageTitle } : {}),
    },
  };
}
