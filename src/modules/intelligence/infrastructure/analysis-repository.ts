/**
 * Analysis repository — provenance for every processing attempt.
 *
 * One memory_analyses row per attempt: what was proposed (validated),
 * what was decided (and why), or what failed and why. Raw model output
 * is deliberately NOT stored — only validated proposals survive, so
 * every record is explainable and re-derivable. Attempts never mutate
 * previous rows; history is append-only, like the memories themselves.
 */

import { db } from "@/lib/db";
import type { AnalysisStatus } from "@/types/processing";

export interface CreateAnalysisData {
  memoryId: string;
  userId: string;
  attempt: number;
  status: AnalysisStatus;
  decision: string | null;
  provider: string;
  analysisJson: string | null;
  comparisonJson: string | null;
  decisionJson: string | null;
  errorReason: string | null;
}

export async function createAnalysis(data: CreateAnalysisData): Promise<string> {
  const row = await db.memoryAnalysis.create({ data });
  return row.id;
}

/** The memory's latest analysis record, or null. Ownership enforced. */
export async function findLatestAnalysis(userId: string, memoryId: string) {
  return db.memoryAnalysis.findFirst({
    where: { memoryId, userId },
    orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
  });
}

/** How many attempts a memory has already had (for the next attempt number). */
export async function countAttempts(memoryId: string): Promise<number> {
  return db.memoryAnalysis.count({ where: { memoryId } });
}
