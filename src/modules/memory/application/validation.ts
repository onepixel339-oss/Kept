/**
 * Memory request validation — the boundary where client input becomes
 * trustworthy input. Zod schemas live beside the service that uses
 * them; API routes and server components both go through the service.
 *
 * Rules of the boundary:
 *  - `originalContent` is preserved VERBATIM (never trimmed) — only
 *    its presence and length are checked. The user's words are sacred.
 *  - Everything else may be normalized (trimmed, defaulted).
 *  - Unknown fields are stripped; nothing unvalidated reaches the
 *    repository.
 */

import { z } from "zod";
import {
  DEFAULT_MEMORY_TYPE,
  MEMORY_STATUSES,
  MEMORY_TYPES,
} from "@/types/memory";

export const memoryIdSchema = z.string().min(1).max(64);

export const createMemorySchema = z.object({
  originalContent: z
    .string()
    .max(10_000, "Keep memories under 10,000 characters.")
    .refine((value) => value.trim().length > 0, {
      message: "Write something first — even a few words.",
    }),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  memoryType: z.enum(MEMORY_TYPES).default(DEFAULT_MEMORY_TYPE),
  importance: z.number().min(0).max(1).optional(),
  rememberedAt: z.coerce.date().nullable().optional(),
});

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

export const updateMemorySchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    summary: z.string().trim().max(2_000).nullable().optional(),
    originalContent: z
      .string()
      .max(10_000, "Keep memories under 10,000 characters.")
      .refine((value) => value.trim().length > 0, {
        message: "A memory needs words — the content cannot be empty.",
      })
      .optional(),
    memoryType: z.enum(MEMORY_TYPES).optional(),
    importance: z.number().min(0).max(1).optional(),
    rememberedAt: z.coerce.date().nullable().optional(),
    status: z.enum(MEMORY_STATUSES).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide something to change.",
  });

export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

export const listMemoriesQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  memoryType: z.enum(MEMORY_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListMemoriesQuery = z.infer<typeof listMemoriesQuerySchema>;
