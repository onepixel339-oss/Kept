/**
 * AI abstraction — the seam between Kept and any AI provider.
 *
 * ARCHITECTURAL LAW (see docs/architecture.md):
 *   The AI never touches the database. It never decides anything.
 *   It receives content and PROPOSES structured understanding.
 *   Application logic validates proposals and the memory module decides.
 *
 * Everything an AI provider may return is a "proposal" — plain data that
 * application code must validate (zod, in later phases) before it comes
 * anywhere near persistence.
 */

import type { MemoryConfidence, MemoryImportance, MemoryType } from "@/types/memory";

/**
 * A proposed understanding of one memory.
 * Every field is optional and untrusted — validation happens in the
 * application layer, never in the prompt and never in the provider.
 */
export interface ProposedMemoryUnderstanding {
  title?: string;
  summary?: string;
  type?: MemoryType;
  importance?: MemoryImportance;
  /** How sure the proposer is. Lower than user-authored certainty by definition. */
  confidence?: MemoryConfidence;
}

/** The input an AI provider may see. No database models, ever. */
export interface UnderstandingRequest {
  /** The user's own words. */
  content: string;
  /** Optional hint about when the remembered thing happened. */
  rememberedAt?: Date;
}

/**
 * The contract for memory understanding.
 *
 * Phase 1 defines the seam only — there is NO implementation and NO
 * fake behavior. When a provider lands, it implements this interface
 * behind the gateway in `lib/ai/gateway.ts`, and the memory module is
 * the only caller.
 */
export interface MemoryUnderstandingProvider {
  proposeUnderstanding(request: UnderstandingRequest): Promise<ProposedMemoryUnderstanding>;
}

/**
 * Runtime AI configuration placeholders. Values arrive via environment
 * variables when a provider is actually introduced — never hardcoded.
 */
export interface AiGatewayConfig {
  providerId: string | null;
  apiKeyEnvVar: string | null;
}
