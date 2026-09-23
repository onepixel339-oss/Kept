/**
 * z.ai provider — the development implementation of the intelligence
 * provider contract, behind the gateway. This is the ONLY file in the
 * application allowed to import the z.ai SDK, and the SDK is backend-only.
 *
 * The provider returns raw model output. It does not parse, validate,
 * or act on it — validation belongs to the intelligence module, and
 * persistence belongs to application logic. A provider failure throws;
 * it never fabricates a fallback response.
 */

import ZAI from "z-ai-web-dev-sdk";
import type {
  AnalyzeMemoryRequest,
  CompareMemoriesRequest,
  EmbedResult,
  EmbeddingRequest,
  MemoryIntelligenceProvider,
  ReadPageRequest,
  ReadPageResult,
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

/**
 * The SDK accepts `assistant`-role messages as the system prompt
 * convention for this gateway; content is always plain text and the
 * model is instructed to answer with raw JSON.
 */
export class ZaiIntelligenceProvider implements MemoryIntelligenceProvider {
  readonly id = "zai";

  /**
   * Honest capability flag (Phase 8 §18): the z.ai SDK in this
   * environment exposes NO embedding API (its full surface is
   * chat/vision, tts/asr, images, video, functions — verified against
   * the installed SDK). Declared false so the gateway's capability
   * gate closes semantic retrieval instead of probing the network.
   */
  readonly embeds = false;

  /**
   * Phase 9 — honest capability flags, verified against the installed
   * SDK at runtime (Phase 9 probes): createVision extracted the exact
   * printed text of a rendered image; audio.asr.create returned a
   * well-formed transcript response. Both capabilities are real here.
   */
  readonly visions = true;
  readonly transcribes = true;
  readonly readsPages = true;

  private async complete(systemPrompt: string, userPayload: string): Promise<string> {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: systemPrompt },
        { role: "user", content: userPayload },
      ],
      thinking: { type: "disabled" },
    });

    const content: unknown = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("The analysis service returned an empty response.");
    }
    return content;
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
   * The z.ai SDK in this environment exposes no text-embedding API, and
   * the project forbids a second (vector) database. Rather than fake a
   * vector, the provider reports honestly that embedding is unavailable
   * (see docs/semantic-memory.md — the interface and the real SQLite
   * repository behind the seam stay ready for a capable provider or
   * PostgreSQL/pgvector).
   */
  async embed(_request: EmbeddingRequest): Promise<EmbedResult> {
    return {
      available: false,
      reason: "Semantic embeddings are not available in this environment yet.",
    };
  }

  /**
   * Phase 4 — propose a structured understanding of the user's question.
   * Raw JSON text: the query module validates it against its own schema
   * and falls back to deterministic understanding on any failure.
   */
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

  /**
   * Phase 5 — compose a grounded answer from the structured ContextPack.
   * Raw JSON text: the reasoning module validates it, grounds every
   * claim against the pack, and runs the verification loop. When
   * regenerating, the previous attempt's verification report travels
   * with the request.
   */
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

  /**
   * Phase 5 — audit a generated answer against the same ContextPack.
   * Raw JSON text: the reasoning module merges this report with its
   * own deterministic checks before deciding validity.
   */
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
   * Phase 9 — see one image, propose { text, description } as raw JSON
   * text. The ingestion module validates it; this layer never parses.
   * The image travels as a data URI — it never touches a public URL.
   */
  async extractImage(request: ExtractImageRequest): Promise<string> {
    const zai = await ZAI.create();
    const dataUri = `data:${request.mimeType};base64,${request.imageBase64}`;
    const completion = await zai.chat.completions.createVision({
      model: "glm-4.5v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_EXTRACTION_PROMPT_V1 },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      thinking: { type: "disabled" },
    });

    const content: unknown = completion?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("The analysis service returned an empty response.");
    }
    return content;
  }

  /**
   * Phase 9 — transcribe user-owned audio via the SDK's ASR endpoint.
   * Returns the raw transcript (it may be empty — silence is honest).
   */
  async transcribe(request: TranscribeRequest): Promise<{ text: string }> {
    const zai = await ZAI.create();
    const result = await zai.audio.asr.create({
      file_base64: request.audioBase64,
    });
    const text: unknown = result?.text;
    if (typeof text !== "string") {
      throw new Error("The transcription service returned no usable text.");
    }
    return { text };
  }

  /**
   * Phase 9 — read a public page through the SDK's hosted page reader
   * (deterministic extraction; no scripts run in this process). The
   * URL was SSRF-validated by the caller. Returns html + title; a
   * non-200 reader outcome throws so the caller can fall back or fail
   * honestly.
   */
  async readPage(request: ReadPageRequest): Promise<ReadPageResult> {
    const zai = await ZAI.create();
    const page = await zai.functions.invoke("page_reader", { url: request.url });
    const code = (page as { code?: unknown }).code;
    const data = (page as { data?: { html?: unknown; title?: unknown } }).data;
    if (code !== 200 || !data || typeof data.html !== "string" || data.html === "") {
      throw new Error("The page reader could not read that page.");
    }
    return {
      html: data.html,
      title: typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim().slice(0, 200) : null,
    };
  }
}
