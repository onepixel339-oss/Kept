/**
 * AI intelligence contracts — the Phase 3 seam.
 *
 * ARCHITECTURAL LAW (docs/architecture.md §2.1), unchanged:
 *   The AI never touches the database. It never decides anything.
 *   It receives plain content and PROPOSES structured understanding.
 *   Application logic validates every proposal and the intelligence
 *   pipeline decides what, if anything, is persisted.
 *
 * Everything a provider returns here is a raw JSON string — untrusted
 * until the intelligence module parses and validates it against its
 * zod schemas (modules/intelligence/domain/ai-schemas.ts). The gateway
 * deliberately does NOT validate: validation is a domain decision, and
 * the domain owns its schemas.
 *
 * The Phase 1 seam (MemoryUnderstandingProvider in types.ts) is
 * preserved untouched. This interface supersedes it for the pipeline;
 * the old contract remains for compatibility and documentation.
 */

import type { UnderstandQueryRequest } from "./query-types";
import type { GenerateAnswerRequest, VerifyAnswerRequest } from "./reasoning-types";
import type { ExtractImageRequest, TranscribeRequest } from "./ingestion-types";

/**
 * Phase 9 — read one public web page through the provider's hosted
 * page reader (a deterministic extraction function, not generation).
 * The URL must already be SSRF-validated by the caller; this contract
 * adds no safety of its own.
 */
export interface ReadPageRequest {
  url: string;
}

export interface ReadPageResult {
  html: string;
  title: string | null;
}

/**
 * Phase 8 — the embedding request. `text` is the CANONICAL semantic
 * representation of a memory (or the raw query, when purpose is
 * "query"); the provider never sees database rows. A query embedding
 * is transient by contract — the gateway and providers never persist
 * it, and no caller may store it as a memory.
 */
export interface EmbeddingRequest {
  /** The text to embed — canonical representation for memories, the raw question for queries. */
  text: string;
  /** Why: persisting a memory's vector, or a transient query vector. */
  purpose: "memory" | "query";
  /** The memory a "memory" embedding belongs to (provenance); never present for queries. */
  memoryId?: string;
}

/** Context the analysis step may see — plain data, never DB models. */
export interface AnalysisContextMemory {
  id: string;
  title: string | null;
  /** Short excerpt of the memory's content. */
  snippet: string;
  memoryType: string;
}

/** Context the analysis step may see — plain data, never DB models. */
export interface AnalysisContextEntity {
  id: string;
  type: string;
  name: string;
}

export interface AnalyzeMemoryRequest {
  /** The user's own words, verbatim. */
  content: string;
  /** The current date (ISO 8601) at the memory's evaluation — for resolving "today". */
  currentDate: string;
  /** IANA timezone the system operates in; dates normalize against it. */
  timezone: string;
  /** Bounded, relevant context assembled by the retrieval step. */
  context: {
    memories: AnalysisContextMemory[];
    entities: AnalysisContextEntity[];
  };
}

export interface CompareMemoriesRequest {
  /** The user's own words, verbatim (the new memory being processed). */
  content: string;
  /** The validated analysis proposal (plain JSON object). */
  candidate: unknown;
  /** Bounded existing memories to compare against. */
  existingMemories: AnalysisContextMemory[];
  /** Bounded existing entities relevant to the candidate. */
  existingEntities: AnalysisContextEntity[];
}

/**
 * The honest result of an embed request. Never a fake vector. A real
 * result carries the model and representation version that produced
 * it — vectors from different models/versions are never compared
 * (Phase 8 §3), so this metadata is part of the contract, not
 * decoration.
 */
export type EmbedResult =
  | {
      available: true;
      vector: number[];
      dimensions: number;
      /** The embedding model identifier the provider used. */
      model: string;
      /** The representation version the provider embedded against. */
      version: string;
    }
  | { available: false; reason: string };

/**
 * The provider contract behind the gateway. Implementations talk to a
 * concrete AI service; they return raw model output (or throw). They
 * never see the database and never decide anything.
 */
export interface MemoryIntelligenceProvider {
  /** Provider identifier, recorded on every analysis for provenance. */
  readonly id: string;

  /** Analyze one memory: propose candidate structure as raw JSON text. */
  analyzeMemory(request: AnalyzeMemoryRequest): Promise<string>;

  /** Compare a candidate against existing memories/entities: raw JSON text. */
  compareMemories(request: CompareMemoriesRequest): Promise<string>;

  /**
   * Static, honest capability flag: can this provider genuinely
   * produce embeddings today? `embed()` existing is not proof (a
   * provider may implement it only to report unavailability with its
   * own reason); `embeds === true` is the provider's word that real
   * vectors come back. The gateway's embedding capability gate
   * requires BOTH.
   */
  readonly embeds?: boolean;

  /** Produce a semantic embedding, or report honestly that it cannot. */
  embed?(request: EmbeddingRequest): Promise<EmbedResult>;

  /**
   * Phase 4 — propose a structured understanding of a user's question
   * (intent, mentions, time, depth). Optional capability: providers
   * without it report honestly and the query module falls back to its
   * deterministic understanding. Returns raw JSON text, unvalidated.
   */
  understandQuery?(request: UnderstandQueryRequest): Promise<string>;

  /**
   * Phase 5 — propose a grounded natural-language answer FROM the
   * structured ContextPack. Optional capability: providers without it
   * report honestly and the reasoning layer falls back to its
   * deterministic retrieval-style response — never a fabricated
   * answer. Returns raw JSON text, unvalidated.
   */
  generateAnswer?(request: GenerateAnswerRequest): Promise<string>;

  /**
   * Phase 5 — audit a generated answer against the same ContextPack.
   * Optional capability: when absent, the reasoning layer relies on
   * its deterministic grounding checks alone (and says so).
   * Returns raw JSON text, unvalidated.
   */
  verifyAnswer?(request: VerifyAnswerRequest): Promise<string>;

  /**
   * Phase 9 — static, honest capability flag: can this provider
   * genuinely see images today? Verified against the installed SDK
   * (createVision returned the exact printed text of a probe image).
   */
  readonly visions?: boolean;

  /**
   * Phase 9 — propose what a user-owned image contains: verbatim
   * readable text plus one factual description, as raw JSON text.
   * Optional capability; providers without it report honestly and the
   * ingestion pipeline preserves the image unextracted (spec §5).
   */
  extractImage?(request: ExtractImageRequest): Promise<string>;

  /**
   * Phase 9 — static, honest capability flag: can this provider
   * genuinely transcribe audio today? Verified against the installed
   * SDK (audio.asr.create returned a well-formed transcript probe).
   */
  readonly transcribes?: boolean;

  /**
   * Phase 9 — transcribe user-owned audio. Returns the raw transcript
   * text; empty transcripts are honest (silence) and validated
   * downstream. Optional capability.
   */
  transcribe?(request: TranscribeRequest): Promise<{ text: string }>;

  /**
   * Phase 9 — static, honest capability flag: can this provider read
   * public pages through its hosted reader? Verified against the
   * installed SDK (functions.invoke("page_reader") probe).
   */
  readonly readsPages?: boolean;

  /**
   * Phase 9 — fetch a validated public URL server-side and return its
   * HTML + title. The URL was already SSRF-validated; hosts inside
   * private ranges never reach any provider.
   */
  readPage?(request: ReadPageRequest): Promise<ReadPageResult>;
}

/** What the gateway hands back after a provider call succeeds. */
export interface ProviderResult {
  /** Raw model output — untrusted JSON text. */
  raw: string;
  /** Provider id (provenance). */
  provider: string;
}
