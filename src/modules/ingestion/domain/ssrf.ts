/**
 * SSRF protection (Phase 9 §15) — URL ingestion is security-sensitive.
 *
 * Every URL passes through here BEFORE any fetch, and every redirect
 * target is re-validated the same way. The validator is pure and
 * dependency-injected (DNS resolution is a parameter), so the whole
 * protection surface is unit-testable without touching the network.
 *
 * Rejected outright:
 *   - non-http(s) schemes (file:, ftp:, data:, javascript:, …)
 *   - non-standard ports (only 80/443)
 *   - localhost and .local/.internal-style hostnames
 *   - any resolved address that is loopback, private, link-local
 *     (including cloud metadata endpoints), CGNAT, reserved, or an
 *     IPv4-mapped IPv6 wrapper around one of the above
 *
 * If DNS resolution fails or disagrees, the URL is rejected — an
 * unresolvable host is not ingested, and a hostname that resolves to
 * ANY private address is rejected even when another record is public
 * (no pinning games).
 */

import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { URL_LIMITS } from "@/config/ingestion";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type UrlLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/** The production resolver — injectable for tests. */
export const defaultLookup: UrlLookup = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
};

/** True when an IPv4 address must never be fetched server-side. */
export function isForbiddenIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true; // not a parseable public IPv4 — do not fetch
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** True when an IPv6 address must never be fetched server-side. */
export function isForbiddenIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified, loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith("f") && (lower.startsWith("fc") || lower.startsWith("fd"))) {
    return true; // unique local fc00::/7
  }
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped — judge by the embedded IPv4 address.
    const embedded = lower.slice("::ffff:".length);
    return isIP(embedded) === 4 ? isForbiddenIPv4(embedded) : true;
  }
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix
  if (lower.startsWith("2001:db8:")) return true; // documentation range
  if (lower.startsWith("100:")) return true; // discard-only range
  return false;
}

function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenIPv4(address);
  if (family === 6) return isForbiddenIPv6(address);
  return true; // unparseable — never fetch
}

/** Hostnames that are local by name, whatever they resolve to. */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Validate one URL for server-side fetching. Pure given the lookup.
 * Returns the normalized URL on success — the same object every fetch
 * (initial or redirect hop) must present.
 */
export async function validatePublicHttpUrl(
  rawUrl: string,
  lookup: UrlLookup = defaultLookup
): Promise<UrlValidationResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "That link is not a valid URL." };
  }

  if (!(URL_LIMITS.protocols as readonly string[]).includes(url.protocol)) {
    return { ok: false, reason: "Only http and https links can be saved." };
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number.parseInt(url.port, 10);
  if (!(URL_LIMITS.ports as readonly number[]).includes(port)) {
    return { ok: false, reason: "Only standard web ports can be saved." };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, ""); // strip trailing dot
  if (!hostname) {
    return { ok: false, reason: "That link has no host." };
  }
  if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { ok: false, reason: "That link points inside this machine." };
  }

  // Literals are checked directly; hostnames are resolved and every
  // record must be public.
  if (isIP(hostname.replace(/^\[|\]$/g, "")) === 6 && hostname.startsWith("[")) {
    const bare = hostname.slice(1, -1);
    if (isForbiddenAddress(bare)) {
      return { ok: false, reason: "That link points at a private address." };
    }
    return { ok: true, url };
  }
  if (isIP(hostname) === 4) {
    if (isForbiddenIPv4(hostname)) {
      return { ok: false, reason: "That link points at a private address." };
    }
    return { ok: true, url };
  }

  let records: ResolvedAddress[];
  try {
    records = await lookup(hostname);
  } catch {
    return { ok: false, reason: "That link could not be resolved." };
  }
  if (!records || records.length === 0) {
    return { ok: false, reason: "That link could not be resolved." };
  }
  if (records.some((record) => isForbiddenAddress(record.address))) {
    return { ok: false, reason: "That link points at a private address." };
  }

  return { ok: true, url };
}
