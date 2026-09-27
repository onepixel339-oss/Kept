/**
 * Gemini provider — the production implementation of the intelligence
 * provider contract, behind the gateway. This is the ONLY file in the
 * application allowed to import the Google GenAI SDK, and the SDK is
 * used server-side only (the key never reaches the browser).
 *
 * The provider returns raw model output. It does not parse, validate,
 * or act on it — validation belongs to the intelligence module, and
 * persistence belongs to application logic. A provider failure throws;
 * it never fabricates a fallback response.
 *
 * Capability notes (honest flags, verified against the live API):
 *  - text analysis / understanding / generation: gemini-2.5-flash,
 *    responding with raw JSON against the SAME versioned prompt assets
 *    the z.ai provider uses (the prompts are provider-agnostic);
 *  - vision: gemini-2.5-flash accepts inline image data;
 *  - audio transcription: gemini-2.5-flash accepts inline audio data;
 *  - embeddings: gemini-embedding-001 via models.embedContent;
 *  - page reading: Gemini has NO hosted page reader — `readsPages` is
 *    false and the gateway reports unavailable; the URL extractor's
 *    own bounded fetch handles pages (the hosted reader was only ever
 *    a fallback there).
 */

import { GoogleGenAI } from "@google/genai";
import type {
  AnalyzeMemoryRequest,
  CompareMemoriesRequest,
  EmbedResult,
  EmbeddingRequest,
  MemoryIntelligenceProvider,
} from "../intelligence-types";
import type { ExtractImageRequest, TranscribeRequest } from "../ingestion-types";
import type { UnderstandQueryRequest } from "../query-types";
import type { GenerateAnswerRequest, VerifyAnswerRequest } from "../reasoning-types";
import { MEMORY_ANALYSIS_PROMPT_V1 } from "@/prompts/memory-analysis/v1";
import { MEMORY_COMPARISON_PROMPT_V1 } from "@/prompts/memory-comparison/v1";
import { QUERY_UNDERSTANDING_PROMPT_V1 } from "@/prompts/query-understanding/v1";
import { ANSWER_GENERATION_PROMPT_V1 } from "@/prompts/answer-generation/v1";
import { ANSWER_VERIFICATION_PROMPT_V1 } from "@/prompts/answer-verification/v1";
import { IMAGE_EXTRACTION_PROMPT_V1 } from "@/prompts/image-extraction/v1";

/** Current GA multimodal model: text + vision + audio in one model.
 *  gemini-2.5-flash returned 404 live ("no longer available to new
 *  users"); the API itself named gemini-3.8-flash as the replacement. */
export const GEMINI_TEXT_MODEL = "gemini-3.8-flash";
/** Current GA text-embedding model (3072-dim default output). */
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * The representation version this provider's embeddings are valid for.
 * MUST stay in lockstep with
 * `modules/intelligence/domain/embedding-representation.ts` (the
 * provider cannot import from modules/* — the dependency points one
 * way) — both are "v1"; bump both together, never one alone.
 */
const EMBEDDING_REPRESENTATION_VERSION = "v1";

export class GeminiIntelligenceProvider implements MemoryIntelligenceProvider {
  readonly id = "gemini";

  /**
   * Honest capability flags. `embeds` is the change the whole semantic
   * layer was built to wait for (Phase 8 §18): the provider genuinely
   * produces embeddings, so the gateway's capability gate opens and
   * the SemanticRetriever starts running without a change there.
   */
  readonly embeds = true;
  readonly visions = true;
  readonly transcribes = true;

  /** No hosted page reader on Gemini — the honest flag; callers fall back. */
  readonly readsPages = false;

  private readonly apiKey: string;
  private client: GoogleGenAI | null = null;

  constructor() {
    // Server-side only, by architecture: the key lives in server env,
    // never in a bundle, never in a cookie, never in client props.
    if (typeof window !== "undefined") {
      throw new Error("The Gemini provider is server-side only.");
    }
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      // Missing configuration must fail honestly (no mock responses).
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    this.apiKey = apiKey;
  }

  private ai(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }

  /**
   * One text completion against the same versioned prompt assets every
   * other provider uses. JSON responses are requested with the JSON
   * MIME type so the model returns parseable raw JSON (the prompts
   * already demand raw JSON); thinking is disabled for latency — these
   * are extraction tasks, not reasoning tasks.
   */
  private async complete(systemPrompt: string, userPayload: string): Promise<string> {
    const response = await this.ai().models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: userPayload }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("The analysis service returned an empty response.");
    }
    return text;
  }

  async analyzeMemory(request: AnalyzeMemoryRequest): Promise<string> {
    const payload = JSON.stringify(
      {
        current_date: request.currentDate,
        timezone: request.timezone,
        memory_text: request.content,
        context: {
          existing_memories: request.context.memories,
          existing_entities: request.context.entities,
        },
      },
      null,
      2
    );
    return this.complete(MEMORY_ANALYSIS_PROMPT_V1, payload);
  }

  async compareMemories(request: CompareMemoriesRequest): Promise<string> {
    const payload = JSON.stringify(
      {
        memory_text: request.content,
        validated_candidate: request.candidate,
        existing_memories: request.existingMemories,
        existing_entities: request.existingEntities,
      },
      null,
      2
    );
    return this.complete(MEMORY_COMPARISON_PROMPT_V1, payload);
  }

  /**
   * Real embeddings via gemini-embedding-001. The vector travels to
   * the repository seam exactly as returned — never trimmed, padded,
   * or normalized here. Memory and query embeddings come from the same
   * model, so stored and query vectors always share the (model,
   * version) identity the repository requires.
   */
  async embed(request: EmbeddingRequest): Promise<EmbedResult> {
    try {
      const response = await this.ai().models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: request.text,
      });

      const values = response.embeddings?.[0]?.values;
      if (!Array.isArray(values) || values.length === 0) {
        return { available: false, reason: "The embedding service returned no vector." };
      }
      for (const value of values) {
        if (!Number.isFinite(value)) {
          return { available: false, reason: "The embedding service returned a non-finite component." };
        }
      }
      return {
        available: true,
        vector: values,
        dimensions: values.length,
        model: GEMINI_EMBEDDING_MODEL,
        version: EMBEDDING_REPRESENTATION_VERSION,
      };
    } catch (error) {
      // A provider failure is honest unavailability with its reason —
      // the pipeline marks the memory `deferred` and stays usable.
      const reason = error instanceof Error ? error.message : "Unknown embedding error.";
      return { available: false, reason };
    }
  }

  async understandQuery(request: UnderstandQueryRequest): Promise<string> {
    const payload = JSON.stringify(
      {
        current_date: request.currentDate,
        timezone: request.timezone,
        scope: request.scope,
        recent_conversation: request.conversation,
        known_entities: request.knownEntities,
        message: request.message,
      },
      null,
      2
    );
    return this.complete(QUERY_UNDERSTANDING_PROMPT_V1, payload);
  }

  async generateAnswer(request: GenerateAnswerRequest): Promise<string> {
    const payload = JSON.stringify(
      {
        current_date: request.currentDate,
        timezone: request.timezone,
        recent_conversation: request.conversation,
        context_pack: request.contextPack,
        question: request.question,
        ...(request.feedback ? { verification_feedback: request.feedback } : {}),
      },
      null,
      2
    );
    return this.complete(ANSWER_GENERATION_PROMPT_V1, payload);
  }

  async verifyAnswer(request: VerifyAnswerRequest): Promise<string> {
    const payload = JSON.stringify(
      {
        current_date: request.currentDate,
        timezone: request.timezone,
        context_pack: request.contextPack,
        question: request.question,
        generated_answer: request.answer,
      },
      null,
      2
    );
    return this.complete(ANSWER_VERIFICATION_PROMPT_V1, payload);
  }

  /**
   * See one image, propose { text, description } as raw JSON text —
   * same prompt asset, same untrusted-output rule as the z.ai
   * provider. The image travels as inline base64 data (never a URL).
   */
  async extractImage(request: ExtractImageRequest): Promise<string> {
    const response = await this.ai().models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: IMAGE_EXTRACTION_PROMPT_V1 },
            { inlineData: { mimeType: request.mimeType, data: request.imageBase64 } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("The analysis service returned an empty response.");
    }
    return text;
  }

  /**
   * Transcribe user-owned audio through the same multimodal model.
   * Returns the raw transcript text — empty is honest (silence) and is
   * validated downstream. No JSON MIME here: the transcript is plain
   * text in the audio's spoken language.
   */
  async transcribe(request: TranscribeRequest): Promise<{ text: string }> {
    const response = await this.ai().models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Transcribe this audio recording. Output ONLY the verbatim transcript of the spoken words, in the language actually spoken — no commentary, no labels, no markdown. If the audio contains no speech, output nothing.",
            },
            { inlineData: { mimeType: request.mimeType, data: request.audioBase64 } },
          ],
        },
      ],
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = response.text;
    if (typeof text !== "string") {
      throw new Error("The transcription service returned no usable text.");
    }
    return { text: text.trim() };
  }
}
