import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Query logging is OFF everywhere (it can echo parameter values —
 * password hashes, private memory content — into development logs;
 * see docs/security.md, logging policy). Enable temporarily with
 * KEPT_DEBUG_DB=1 when a specific query must be inspected.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.KEPT_DEBUG_DB === "1" ? ["query"] : ["error"],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
