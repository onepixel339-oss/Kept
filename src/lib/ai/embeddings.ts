/**
 * Embedding repository seam — Phase 8: the contract is REAL, and so is
 * the SQLite implementation behind it (sqlite-embeddings.ts).
 *
 * Phase 3 decision (superseded in scope, preserved in spirit): vectors
 * are never fabricated. What HAS changed is that persistence itself no
 * longer needs to defer — this environment's SQLite database can store
 * a real provider's real vectors honestly (Float32 BLOB) and score
 * them with real cosine similarity. What stays deferred is the
 * EMBEDDING PROVIDER: the z.ai SDK in this environment exposes no
 * embedding API, and no alternative provider is permitted by the
 * project's runtime policy (user-free, no client keys, no new paid
 * services). So in production today nothing ever reaches `store` —
 * the pipeline reports `deferred` — and every layer below this line
 * is exercised only with deterministic fixture vectors in tests,
 * never with invented production data.
 *
 * When a capable provider (or PostgreSQL/pgvector) arrives, only two
 * things change: the provider announces `embeds: true`, and a
 * PgVectorEmbeddingRepository replaces the SQLite one behind this same
 * interface. Nothing above the seam moves. See docs/semantic-memory.md.
 *
 * No code may bypass this seam to "just store a JSON array" — that is
 * the fragile workaround the phase spec forbids.
 */

/** The model/version identity every stored vector carries (Phase 8 §3). */
export interface EmbeddingMetadata {
  /** Embedding model identifier — vectors from different models are NEVER compared. */
  model: string;
  /** Representation version — a change here means regenerate, never reuse. */
  version: string;
  /** Vector dimensionality, validated on every write and search. */
  dimensions: number;
}

export interface EmbeddingSearchHit {
  memoryId: string;
  /** Cosine similarity in [-1, 1] — raw and honest; callers normalize. */
  score: number;
}

export interface EmbeddingRepository {
  /** Whether this repository can genuinely store and return vectors today. */
  readonly availability: "available" | "deferred";

  /**
   * Store (or idempotently update) the embedding for one memory under
   * one (model, version) identity. Repeated retries reuse the same
   * logical row — never duplicates (Phase 8 §6).
   */
  store(memoryId: string, vector: number[], meta: EmbeddingMetadata): Promise<void>;

  /**
   * Read the stored embedding for one memory. With `meta`, only a
   * CURRENT (model, version) match is returned — an incompatible old
   * vector reads as null, never silently as current (Phase 8 §4).
   */
  find(memoryId: string, meta?: EmbeddingMetadata): Promise<number[] | null>;

  /** Remove the embedding for one memory (also enforced by FK cascade). */
  delete(memoryId: string): Promise<void>;

  /**
   * Mark every stored vector for one memory as no-longer-current
   * (status → pending). Called when a memory's text changes: the old
   * vector must never represent the new content (Phase 8 §22).
   */
  invalidate(memoryId: string): Promise<void>;

  /**
   * Cosine-similarity search over ONE user's stored vectors, best
   * first. Ownership is structural: the join goes through the
   * memories table's user_id, so no cross-user row can be returned
   * (Phase 8 §20). Only vectors whose (model, version) match `meta`
   * and whose status is ready participate — incompatible or stale
   * vectors are never compared.
   */
  search(
    userId: string,
    queryVector: number[],
    meta: EmbeddingMetadata,
    limit: number
  ): Promise<EmbeddingSearchHit[]>;
}

/** Error thrown when embedding storage is used while deferred. */
export class EmbeddingUnavailableError extends Error {
  constructor() {
    super("Embedding storage is deferred in this environment (SQLite).");
    this.name = "EmbeddingUnavailableError";
  }
}

/**
 * The honestly-deferred repository — kept for environments/tests that
 * must represent "no vector storage". Every method tells the truth:
 * nothing was ever stored, so reads are empty and searches find
 * nothing; `store` throws rather than pretending.
 */
export class DeferredEmbeddingRepository implements EmbeddingRepository {
  readonly availability = "deferred" as const;

  async store(_memoryId: string, _vector: number[], _meta: EmbeddingMetadata): Promise<void> {
    throw new EmbeddingUnavailableError();
  }

  async find(_memoryId: string, _meta?: EmbeddingMetadata): Promise<number[] | null> {
    return null;
  }

  async delete(_memoryId: string): Promise<void> {
    // Nothing was ever stored; deletion is trivially complete.
  }

  async invalidate(_memoryId: string): Promise<void> {
    // Nothing was ever stored; there is nothing to invalidate.
  }

  async search(
    _userId: string,
    _queryVector: number[],
    _meta: EmbeddingMetadata,
    _limit: number
  ): Promise<EmbeddingSearchHit[]> {
    return [];
  }
}
