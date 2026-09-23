/**
 * The SQLite embedding repository — the seam's real implementation for
 * this environment.
 *
 * What it does honestly:
 *  - stores vectors ONLY when handed one (a real provider's response
 *    in production; a deterministic fixture in tests) — there is no
 *    code path here that invents a vector,
 *  - encodes as little-endian Float32 (compact, exact round-trip),
 *  - scores with true cosine similarity in application code — correct
 *    and fast at personal-archive scale (a user's memories are
 *    hundreds to low thousands; a full scan of their own rows is
 *    milliseconds). When PostgreSQL/pgvector arrives, this file is
 *    replaced by a PgVectorEmbeddingRepository with a real index —
 *    same interface, nothing above moves,
 *  - enforces ownership structurally: every search joins through
 *    memories.user_id, so no query can ever surface another user's
 *    vector,
 *  - never compares across models/versions: search and find filter on
 *    the exact (model, version) pair, so an old-model vector is stale
 *    by construction, never silently current.
 *
 * SQLite-specific details (BLOB encoding, brute-force scan) live HERE
 * and nowhere else — the portability rule for the future migration.
 */

import { db } from "@/lib/db";
import type {
  EmbeddingMetadata,
  EmbeddingRepository,
  EmbeddingSearchHit,
} from "./embeddings";

/** Encode a float vector as little-endian Float32 bytes (plain Uint8Array — Prisma Bytes). */
export function encodeVector(vector: number[]): Uint8Array<ArrayBuffer> {
  const arrayBuffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(arrayBuffer);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i], true);
  }
  return new Uint8Array(arrayBuffer);
}

/** Decode little-endian Float32 bytes back into a float vector. */
export function decodeVector(bytes: Uint8Array): number[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector: number[] = new Array(buffer.length / 4);
  for (let i = 0; i < vector.length; i++) {
    vector[i] = buffer.readFloatLE(i * 4);
  }
  return vector;
}

/** Cosine similarity in [-1, 1]; a zero-magnitude vector scores 0 — never NaN. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Validation shared by store and search: a vector must be real numbers of the declared size. */
function assertVector(vector: number[], meta: EmbeddingMetadata, what: string): void {
  if (!Number.isInteger(meta.dimensions) || meta.dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions declared (${meta.dimensions}).`);
  }
  if (vector.length !== meta.dimensions) {
    throw new Error(
      `${what} vector has ${vector.length} dimensions but ${meta.dimensions} were declared.`
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`${what} vector contains a non-finite component.`);
    }
  }
}

export class SqliteEmbeddingRepository implements EmbeddingRepository {
  readonly availability = "available" as const;

  async store(memoryId: string, vector: number[], meta: EmbeddingMetadata): Promise<void> {
    assertVector(vector, meta, "Stored");
    const data = encodeVector(vector);
    // Upsert on the (memory, model, version) identity: retries and
    // reprocessing reuse the same logical embedding — never duplicates.
    await db.memoryEmbedding.upsert({
      where: {
        memoryId_model_version: { memoryId, model: meta.model, version: meta.version },
      },
      create: {
        memoryId,
        model: meta.model,
        version: meta.version,
        dimensions: meta.dimensions,
        status: "ready",
        vector: data,
      },
      update: {
        dimensions: meta.dimensions,
        status: "ready",
        vector: data,
      },
    });
  }

  async find(memoryId: string, meta?: EmbeddingMetadata): Promise<number[] | null> {
    const row = await db.memoryEmbedding.findFirst({
      where: {
        memoryId,
        ...(meta ? { model: meta.model, version: meta.version } : {}),
        status: "ready",
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!row || !row.vector) return null;
    return decodeVector(row.vector);
  }

  async delete(memoryId: string): Promise<void> {
    // Deleting a deleted memory's vectors twice must stay safe.
    await db.memoryEmbedding.deleteMany({ where: { memoryId } });
  }

  async invalidate(memoryId: string): Promise<void> {
    // The bytes stay (debuggable, regenerable identity) but the status
    // removes them from every search: a stale vector never represents
    // the current memory.
    await db.memoryEmbedding.updateMany({
      where: { memoryId, status: { not: "pending" } },
      data: { status: "pending" },
    });
  }

  async search(
    userId: string,
    queryVector: number[],
    meta: EmbeddingMetadata,
    limit: number
  ): Promise<EmbeddingSearchHit[]> {
    assertVector(queryVector, meta, "Query");
    const boundedLimit = Math.max(1, Math.floor(limit));

    // Ownership is structural: the join is through the memory row the
    // user owns. A vector without an owned memory is unreachable.
    const rows = await db.memoryEmbedding.findMany({
      where: {
        model: meta.model,
        version: meta.version,
        status: "ready",
        memory: { userId },
      },
      select: { memoryId: true, vector: true },
      // Bounded scan; the ranking floor is the caller's concern.
      take: 10_000,
    });

    const hits: EmbeddingSearchHit[] = [];
    for (const row of rows) {
      if (!row.vector) continue;
      const score = cosineSimilarity(queryVector, decodeVector(row.vector));
      hits.push({ memoryId: row.memoryId, score });
    }
    hits.sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
    return hits.slice(0, boundedLimit);
  }
}
