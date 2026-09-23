/**
 * Data rights — the three powers the product promises its owner:
 *
 *  1. EXPORT      — a complete, machine-readable copy of everything
 *                   the account owns (GET /api/export).
 *  2. DELETE      — real account deletion: transactional, cascading,
 *                   session-destroying, deterministic.
 *  3. CLAIM       — an EXPLICIT, one-shot import of the browser's old
 *                   anonymous (pre-Phase-7) local data into the
 *                   signed-in account. Old development data is never
 *                   silently associated with an account; this is the
 *                   only door, and the user presses it on purpose.
 *
 * None of these ever touch another user's data: every query here is
 * scoped by the authenticated user id, and the claim flow refuses
 * anything that is not an anonymous legacy row.
 */

import { z } from "zod";

import { db } from "@/lib/db";
import { AppError } from "@/lib/api";
import { verifyIdentityValue, IDENTITY_COOKIE } from "@/lib/identity";
import { invalidateAllSessions } from "@/modules/user/application/current-user";
import { verifyPassword } from "@/modules/user/infrastructure/password";

/* ————————————————— export ————————————————— */

export interface ExportPayload {
  schema: "kept.export.v1";
  exportedAt: string;
  account: { email: string | null; name: string | null; createdAt: string };
  counts: Record<string, number>;
  memories: Array<
    Record<string, unknown> & { versions: Array<Record<string, unknown>> }
  >;
  entities: Array<Record<string, unknown>>;
  memoryEntities: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  chats: Array<Record<string, unknown>>;
}

/**
 * Gather every owned record for the authenticated user, in a stable,
 * self-describing shape. Deliberately EXCLUDED (documented in
 * docs/security.md): password hashes, sessions, reset tokens, and
 * memory_analyses (internal processing machinery — recomputable,
 * never part of the memory itself). Internal prompts and provider
 * details never leave the server.
 */
export async function exportUserData(userId: string): Promise<ExportPayload> {
  const account = await db.user.findUnique({ where: { id: userId } });
  if (!account) {
    throw new AppError("not_found", "This account no longer exists.");
  }

  const [memories, entities, memoryEntities, relations, sources, chats] =
    await Promise.all([
      db.memory.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        include: { versions: { orderBy: { versionNumber: "asc" } } },
      }),
      db.entity.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      db.memoryEntity.findMany({
        where: { memory: { userId } },
        orderBy: { memoryId: "asc" },
      }),
      db.relation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      db.source.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      db.chatMessage.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

  const plain = <T extends object>(row: T): Record<string, unknown> =>
    JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

  return {
    schema: "kept.export.v1",
    exportedAt: new Date().toISOString(),
    account: {
      email: account.email,
      name: account.name,
      createdAt: account.createdAt.toISOString(),
    },
    counts: {
      memories: memories.length,
      memoryVersions: memories.reduce((n, m) => n + m.versions.length, 0),
      entities: entities.length,
      memoryEntities: memoryEntities.length,
      relations: relations.length,
      sources: sources.length,
      chats: chats.length,
    },
    memories: memories.map((m) => {
      const { versions, ...rest } = m;
      return {
        ...plain(rest),
        versions: versions.map(plain),
      } as ExportPayload["memories"][number];
    }),
    entities: entities.map(plain),
    memoryEntities: memoryEntities.map(plain),
    relations: relations.map(plain),
    sources: sources.map(plain),
    chats: chats.map(plain),
  };
}

/* ————————————————— account deletion ————————————————— */

export interface DeletionSummary {
  memories: number;
  entities: number;
  relations: number;
  sources: number;
  chats: number;
}

const currentPasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your password to confirm.").max(200),
});

/**
 * Delete the account and EVERYTHING it owns, inside one transaction.
 * The database's cascade rules (memories → versions/links/analyses,
 * memories/entities → memory_entities, user → sessions/tokens) carry
 * the rest; a post-delete count check makes the operation
 * deterministic rather than assumed. Shared/global data does not
 * exist — every table in this schema is user-scoped.
 */
export async function deleteAccount(
  userId: string,
  input: unknown
): Promise<DeletionSummary> {
  const parsed = currentPasswordSchema.parse(input);

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError("not_found", "This account no longer exists.");
  }
  if (user.passwordHash) {
    const valid = await verifyPassword(parsed.currentPassword, user.passwordHash);
    if (!valid) {
      throw new AppError("unauthorized", "Your password isn't right.");
    }
  }

  const before = {
    memories: await db.memory.count({ where: { userId } }),
    entities: await db.entity.count({ where: { userId } }),
    relations: await db.relation.count({ where: { userId } }),
    sources: await db.source.count({ where: { userId } }),
    chats: await db.chatMessage.count({ where: { userId } }),
  };

  await db.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } });
  });

  // Sessions and reset tokens die by cascade; assert the account is
  // truly gone so a partial, silent deletion can never pass.
  const gone = await db.user.findUnique({ where: { id: userId } });
  if (gone) {
    throw new AppError("internal_error", "The account could not be fully removed.");
  }
  const sessionsLeft = await db.session.count({ where: { userId } });
  if (sessionsLeft > 0) {
    await invalidateAllSessions(userId);
  }

  return before;
}

/* ————————————————— legacy data claim ————————————————— */

export interface ClaimPreview {
  available: boolean;
  reason?: "no-ticket" | "self" | "not-anonymous" | "empty";
  legacyEmail?: null;
}

export interface ClaimOutcome {
  memories: number;
  entities: number;
  mergedEntities: number;
  relations: number;
  sources: number;
  chats: number;
}

/**
 * Inspect the legacy anonymous identity cookie WITHOUT changing
 * anything. Used by the settings page to decide whether the import
 * card should appear.
 */
export async function previewLegacyClaim(
  currentUserId: string,
  legacyCookieValue: string | undefined | null
): Promise<ClaimPreview> {
  const legacyUserId = verifyIdentityValue(legacyCookieValue);
  if (!legacyUserId) return { available: false, reason: "no-ticket" };
  if (legacyUserId === currentUserId) return { available: false, reason: "self" };

  const legacy = await db.user.findUnique({
    where: { id: legacyUserId },
    include: { _count: { select: { memories: true, entities: true, chats: true } } },
  });
  if (!legacy || legacy.passwordHash || legacy.email) {
    // Only anonymous development rows are claimable — never accounts.
    return { available: false, reason: "not-anonymous" };
  }
  const empty =
    legacy._count.memories === 0 &&
    legacy._count.entities === 0 &&
    legacy._count.chats === 0;
  if (empty) return { available: false, reason: "empty" };

  return { available: true, legacyEmail: null };
}

/**
 * The explicit import. Rules:
 *  - the ticket must be a validly signed ANONYMOUS legacy row
 *    (no email, no password) — a real account can never be claimed;
 *  - colliding entities (same type + canonical name in the target
 *    account) are MERGED into the existing entity — links and
 *    relations are repointed, exact duplicates removed, and the
 *    duplicate row is deleted. Nothing is silently lost;
 *  - everything happens in ONE transaction, ending with the legacy
 *    row's removal and (at the route) the cookie's clearance.
 */
export async function claimLocalIdentity(
  currentUserId: string,
  legacyCookieValue: string | undefined | null
): Promise<ClaimOutcome> {
  const legacyUserId = verifyIdentityValue(legacyCookieValue);
  if (!legacyUserId) {
    throw new AppError("validation_failed", "There is no local data to import.");
  }
  if (legacyUserId === currentUserId) {
    throw new AppError("validation_failed", "This data already belongs to you.");
  }

  const legacy = await db.user.findUnique({ where: { id: legacyUserId } });
  if (!legacy) {
    // Unknown or already-claimed ticket: nothing to import.
    throw new AppError("validation_failed", "There is no local data to import.");
  }
  if (legacy.passwordHash || legacy.email) {
    // Only anonymous development rows are claimable — never accounts.
    throw new AppError("forbidden", "Only local development data can be imported.");
  }

  return db.$transaction(async (tx) => {
    let mergedEntities = 0;

    // 1 — entities: merge the colliding ones, adopt the rest.
    const legacyEntities = await tx.entity.findMany({
      where: { userId: legacyUserId },
    });
    for (const entity of legacyEntities) {
      const existing = await tx.entity.findUnique({
        where: {
          userId_type_canonicalName: {
            userId: currentUserId,
            type: entity.type,
            canonicalName: entity.canonicalName,
          },
        },
      });

      if (!existing) {
        await tx.entity.update({
          where: { id: entity.id },
          data: { userId: currentUserId },
        });
        continue;
      }

      // Merge: repoint memory links, skipping duplicates.
      const links = await tx.memoryEntity.findMany({
        where: { entityId: entity.id },
      });
      for (const link of links) {
        const dupe = await tx.memoryEntity.findUnique({
          where: {
            memoryId_entityId: { memoryId: link.memoryId, entityId: existing.id },
          },
        });
        if (dupe) {
          await tx.memoryEntity.delete({
            where: { memoryId_entityId: { memoryId: link.memoryId, entityId: entity.id } },
          });
        } else {
          await tx.memoryEntity.update({
            where: { memoryId_entityId: { memoryId: link.memoryId, entityId: entity.id } },
            data: { entityId: existing.id },
          });
        }
      }

      // Repoint entity-endpoint relations, then drop exact duplicates.
      await tx.relation.updateMany({
        where: { sourceType: "entity", sourceId: entity.id },
        data: { sourceId: existing.id },
      });
      await tx.relation.updateMany({
        where: { targetType: "entity", targetId: entity.id },
        data: { targetId: existing.id },
      });
      await tx.entity.delete({ where: { id: entity.id } });
      mergedEntities += 1;
    }

    // 2 — deduplicate exact relations the merge may have created.
    const relations = await tx.relation.findMany({ where: { userId: currentUserId } });
    const seen = new Set<string>();
    for (const relation of relations) {
      const key = [
        relation.sourceType,
        relation.sourceId,
        relation.relationType,
        relation.targetType,
        relation.targetId,
      ].join("|");
      if (seen.has(key)) {
        await tx.relation.delete({ where: { id: relation.id } });
      } else {
        seen.add(key);
      }
    }

    // 3 — flip ownership of everything else (ids are stable, so
    // versions, links, and analyses follow their parents).
    const counts = {
      memories: await tx.memory.updateMany({
        where: { userId: legacyUserId },
        data: { userId: currentUserId },
      }),
      relations: await tx.relation.updateMany({
        where: { userId: legacyUserId },
        data: { userId: currentUserId },
      }),
      sources: await tx.source.updateMany({
        where: { userId: legacyUserId },
        data: { userId: currentUserId },
      }),
      analyses: await tx.memoryAnalysis.updateMany({
        where: { userId: legacyUserId },
        data: { userId: currentUserId },
      }),
      chats: await tx.chatMessage.updateMany({
        where: { userId: legacyUserId },
        data: { userId: currentUserId },
      }),
    };

    // 4 — the legacy row has nothing left; remove it by name.
    await tx.user.delete({ where: { id: legacyUserId } });

    void IDENTITY_COOKIE; // the cookie itself is cleared by the route
    return {
      memories: counts.memories.count,
      entities: legacyEntities.length - mergedEntities,
      mergedEntities,
      relations: counts.relations.count,
      sources: counts.sources.count,
      chats: counts.chats.count,
    };
  });
}
