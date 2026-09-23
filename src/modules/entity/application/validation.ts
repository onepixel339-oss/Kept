/**
 * Entity and graph request validation. Same boundary rules as the
 * memory module: parse here, trust nothing above or below.
 */

import { z } from "zod";
import {
  DEFAULT_ENTITY_ROLE,
  ENTITY_ROLES,
  ENTITY_TYPES,
} from "@/types/entity";
import { RELATION_NODE_TYPES, RELATION_TYPES } from "@/types/relation";

export const entityIdSchema = z.string().min(1).max(64);

export const createEntitySchema = z.object({
  type: z.enum(ENTITY_TYPES),
  name: z.string().trim().min(1, "An entity needs a name.").max(120),
  description: z.string().trim().max(500).nullable().optional(),
});

export type CreateEntityInput = z.infer<typeof createEntitySchema>;

export const linkMemoryEntitySchema = z.object({
  role: z.enum(ENTITY_ROLES).default(DEFAULT_ENTITY_ROLE),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type LinkMemoryEntityInput = z.infer<typeof linkMemoryEntitySchema>;

export const createRelationSchema = z
  .object({
    sourceType: z.enum(RELATION_NODE_TYPES),
    sourceId: z.string().min(1).max(64),
    relationType: z.enum(RELATION_TYPES),
    targetType: z.enum(RELATION_NODE_TYPES),
    targetId: z.string().min(1).max(64),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .refine(
    (value) => !(value.sourceType === value.targetType && value.sourceId === value.targetId),
    { message: "A thing cannot relate to itself." }
  );

export type CreateRelationInput = z.infer<typeof createRelationSchema>;
