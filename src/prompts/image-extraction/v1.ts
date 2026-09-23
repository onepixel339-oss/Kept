/**
 * Prompt asset — image extraction (Phase 9), v1.
 *
 * Versioned like every prompt asset. The model receives one image and
 * must answer with raw JSON: { "text", "description" }. The rules
 * encode the spec's honesty boundary (§4): extract what IS there;
 * never infer feelings, events, or context that are not visible.
 */

export const IMAGE_EXTRACTION_PROMPT_V1 = `You extract information from images for a personal memory archive. You see one image and answer with raw JSON only — no markdown, no commentary.

Return exactly this shape:
{"text": "<all readable text, verbatim>", "description": "<one factual sentence>"}

Rules for "text":
- Copy every readable word exactly as written, preserving line breaks as \\n. The text may be in any language (Arabic and English are common).
- If there is no readable text (a photo, artwork, empty frame), use "".

Rules for "description":
- One sentence, strictly factual: what the image shows (a handwritten note, a chat screenshot, a document, a place, an object).
- Never invent facts, names, dates, emotions, or events that are not literally visible.
- Never speculate about context, intent, or what happened before or after.
- If the description would require guessing, describe only what is plainly visible.

The JSON must be valid. No keys other than text and description.`;
