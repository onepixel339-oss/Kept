/**
 * AI gateway — the single door between Kept and AI providers.
 *
 * Phase 3 status: real. The gateway selects the provider from
 * configuration, constructs requests from versioned prompt assets, and
 * returns RAW provider output. It never validates proposals (that is
 * the intelligence module's domain logic), never touches the database,
 * and never imports from `modules/*` — dependency points one way:
 * modules → gateway.
 *
 * Rules every implementation must obey (unchanged from Phase 1):
 *  1. The gateway is the ONLY module allowed to construct AI requests.
 *  2. Providers return proposals; they never receive database types.
 *  3. The gateway never imports from `modules/*`.
 *  4. Missing configuration must fail honestly (no mock responses).
 *
 * The rest of the application must NOT call z.ai (or any provider)
 * directly — everything goes through `getAiGateway()`.
 */

import type {
  AnalyzeMemoryRequest,
  CompareMemoriesRequest,
  EmbedResult,
  EmbeddingRequest,
  MemoryIntelligenceProvider,
  ProviderResult,
  ReadPageRequest,
  ReadPageResult,
} from "./intelligence-types";
import type {
  ExtractImageRequest,
  ImageExtractionResult,
  TranscribeRequest,
  TranscriptionResult,
} from "./ingestion-types";
import type { UnderstandQueryRequest } from "./query-types";
import type { GenerateAnswerRequest, VerifyAnswerRequest } from "./reasoning-types";
import { ZaiIntelligenceProvider } from "./providers/zai";
import { DeferredEmbeddingRepository, type EmbeddingRepository } from "./embeddings";
import { SqliteEmbeddingRepository } from "./sqlite-embeddings";

export type * from "./types";
export type * from "./intelligence-types";
export type * from "./query-types";
export type * from "./reasoning-types";
export {
  DeferredEmbeddingRepository,
  EmbeddingUnavailableError,
  type EmbeddingMetadata,
  type EmbeddingRepository,
  type EmbeddingSearchHit,
} from "./embeddings";
export {
  SqliteEmbeddingRepository,
  cosineSimilarity,
  decodeVector,
  encodeVector,
} from "./sqlite-embeddings";

/**
 * Provider selection. `AI_PROVIDER` names the provider ("zai" today);
 * when unset, the development default is z.ai. An unknown name fails
 * honestly at call time — never a silent mock.
 */
function selectProvider(): MemoryIntelligenceProvider {
  const configured = (process.env.AI_PROVIDER ?? "zai").trim().toLowerCase();
  if (configured === "zai") {
    return new ZaiIntelligenceProvider();
  }
  throw new Error(`The configured AI provider "${configured}" is not available.`);
}

/**
 * The result of an understand-query attempt. "Unavailable" is honest
 * (no provider support, no configuration) — never a fabricated
 * understanding. The caller falls back to deterministic understanding.
 */
export type UnderstandQueryResult =
  | { available: true; raw: string; provider: string }
  | { available: false; reason: string };

/**
 * The result of a reasoning attempt. "Unavailable" is honest (no
 * provider capability, no configuration) — never a fabricated answer.
 * The caller falls back to its deterministic, retrieval-honest
 * behavior.
 */
export type ReasoningAttemptResult =
  | { available: true; raw: string; provider: string }
  | { available: false; reason: string };

/** The gateway the rest of the application talks to. */
export interface AiGateway {
  readonly providerId: string;
  analyzeMemory(request: AnalyzeMemoryRequest): Promise<ProviderResult>;
  compareMemories(request: CompareMemoriesRequest): Promise<ProviderResult>;
  /**
   * Phase 8 — embed a memory's canonical representation (purpose
   * "memory") or a user's question (purpose "query", transient —
   * never persisted). Honest unavailable when the provider cannot
   * embed; never a fabricated vector.
   */
  embed(request: EmbeddingRequest): Promise<EmbedResult>;
  /**
   * Phase 4 — propose a structured understanding of a user's question.
   * Raw output, unvalidated; the query module owns the schema.
   */
  understandQuery(request: UnderstandQueryRequest): Promise<UnderstandQueryResult>;
  /**
   * Phase 5 — propose a grounded answer from the structured
   * ContextPack. Raw output, unvalidated; the reasoning module owns
   * the schema, the grounding pass, and the verification loop.
   */
  generateAnswer(request: GenerateAnswerRequest): Promise<ReasoningAttemptResult>;
  /**
   * Phase 5 — audit a generated answer against the same ContextPack.
   * Raw output, unvalidated; the reasoning module merges it with its
   * own deterministic checks.
   */
  verifyAnswer(request: VerifyAnswerRequest): Promise<ReasoningAttemptResult>;
  /**
   * The embedding repository seam. In this environment: the REAL
   * SQLite implementation (it stores only vectors a provider actually
   * produced — today production produces none; tests use fixtures).
   * The deferred repository remains available for environments that
   * must represent "no storage".
   */
  embeddings(): EmbeddingRepository;
  /**
   * Phase 8 — the honest embedding capability gate. `provider`: the
   * configured provider genuinely produces embeddings (it declares
   * `embeds: true` AND implements embed()). `storage`: the repository
   * seam can persist and search vectors. `ready`: both — the only
   * state in which semantic retrieval may run. In this environment
   * `provider` is false (the z.ai SDK has no embedding API), so
   * `ready` is false and the planner never schedules semantic — the
   * honest deferral the spec mandates. Never faked true.
   */
  embeddingCapability(): { provider: boolean; storage: boolean; ready: boolean };
  /**
   * Phase 9 — propose what a user-owned image contains (verbatim text
   * + one factual description). Raw output, unvalidated; the ingestion
   * module owns the schema. Honest unavailable when the provider has
   * no vision capability — never a fabricated extraction.
   */
  extractImage(request: ExtractImageRequest): Promise<ImageExtractionResult>;
  /**
   * Phase 9 — transcribe user-owned audio. Honest unavailable when the
   * provider has no transcription capability; the original audio stays
   * preserved either way. Never an invented transcript.
   */
  transcribe(request: TranscribeRequest): Promise<TranscriptionResult>;
  /**
   * Phase 9 — read a validated public page via the provider's hosted
   * reader (deterministic extraction). Honest unavailable when the
   * provider has no such capability; the caller falls back to its own
   * bounded fetch or reports failure — never a fabricated page.
   */
  readPage(request: ReadPageRequest): Promise<ReadPageResult | null>;
}

class Gateway implements AiGateway {
  private readonly provider: MemoryIntelligenceProvider;
  private readonly embeddingRepository: EmbeddingRepository;

  constructor(provider: MemoryIntelligenceProvider) {
    this.provider = provider;
    // The real seam implementation for this environment. It never
    // fabricates anything — it persists exactly what a provider
    // returns, and today no production provider returns vectors.
    this.embeddingRepository = new SqliteEmbeddingRepository();
  }

  get providerId(): string {
    return this.provider.id;
  }

  async analyzeMemory(request: AnalyzeMemoryRequest): Promise<ProviderResult> {
    const raw = await this.provider.analyzeMemory(request);
    return { raw, provider: this.provider.id };
  }

  async compareMemories(request: CompareMemoriesRequest): Promise<ProviderResult> {
    const raw = await this.provider.compareMemories(request);
    return { raw, provider: this.provider.id };
  }

  async embed(request: EmbeddingRequest): Promise<EmbedResult> {
    if (!this.provider.embed) {
      return { available: false, reason: "This provider cannot embed." };
    }
    return this.provider.embed(request);
  }

  async understandQuery(request: UnderstandQueryRequest): Promise<UnderstandQueryResult> {
    if (!this.provider.understandQuery) {
      return {
        available: false,
        reason: "This provider cannot understand queries.",
      };
    }
    const raw = await this.provider.understandQuery(request);
    return { available: true, raw, provider: this.provider.id };
  }

  async generateAnswer(request: GenerateAnswerRequest): Promise<ReasoningAttemptResult> {
    if (!this.provider.generateAnswer) {
      return {
        available: false,
        reason: "This provider cannot generate grounded answers.",
      };
    }
    const raw = await this.provider.generateAnswer(request);
    return { available: true, raw, provider: this.provider.id };
  }

  async verifyAnswer(request: VerifyAnswerRequest): Promise<ReasoningAttemptResult> {
    if (!this.provider.verifyAnswer) {
      return {
        available: false,
        reason: "This provider cannot verify answers.",
      };
    }
    const raw = await this.provider.verifyAnswer(request);
    return { available: true, raw, provider: this.provider.id };
  }

  embeddings(): EmbeddingRepository {
    return this.embeddingRepository;
  }

  async extractImage(request: ExtractImageRequest): Promise<ImageExtractionResult> {
    if (!this.provider.extractImage || this.provider.visions !== true) {
      return {
        available: false,
        reason: "This provider cannot read images.",
      };
    }
    const raw = await this.provider.extractImage(request);
    return { available: true, raw, provider: this.provider.id };
  }

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    if (!this.provider.transcribe || this.provider.transcribes !== true) {
      return {
        available: false,
        reason: "This provider cannot transcribe audio.",
      };
    }
    const result = await this.provider.transcribe(request);
    return { available: true, text: result.text, provider: this.provider.id };
  }

  async readPage(request: ReadPageRequest): Promise<ReadPageResult | null> {
    if (!this.provider.readPage || this.provider.readsPages !== true) {
      return null;
    }
    const result = await this.provider.readPage(request);
    return result;
  }

  embeddingCapability(): { provider: boolean; storage: boolean; ready: boolean } {
    const provider = this.provider.embeds === true && typeof this.provider.embed === "function";
    const storage = this.embeddingRepository.availability === "available";
    return { provider, storage, ready: provider && storage };
  }
}

let cached: AiGateway | null = null;

/**
 * The application's one gateway instance. Tests inject their own
 * provider through the pipeline (processMemory accepts a provider) —
 * they never point this gateway at the network.
 */
export function getAiGateway(): AiGateway {
  if (!cached) {
    cached = new Gateway(selectProvider());
  }
  return cached;
}

/**
 * Test seam — swap the singleton for a fixture gateway (or restore it
 * with null). NEVER call this from application code: the only caller
 * is the test suite, which needs ingestion extractors to run against
 * deterministic fixtures instead of the network.
 */
export function setAiGatewayForTests(gateway: AiGateway | null): void {
  cached = gateway;
}
