"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * AskBox — the question surface and its grounded answer.
 *
 * One exchange at a time, follow-ups welcome (the conversation id is
 * kept so follow-ups like "أقصد بتاع المشروع" resolve). The answer is
 * written FROM the retrieved memories — nothing else — and carries its
 * provenance quietly: "Based on N memories", inspectable, with the
 * supporting memories one click away. Uncertainty is stated, never
 * hidden. No chat bubbles, no AI theatrics: a question, an answer,
 * and the memories behind it.
 *
 * Scope props focus the conversation (chat scopes): a memory, an
 * entity/topic — the same pipeline, seeded with the focused thing.
 */

interface AskResponse {
  ok: boolean;
  data?: {
    conversationId: string;
    understanding: {
      intent: string;
      depth: string;
      time: { kind: string; from: string | null; to: string | null; uncertain: boolean; expression: string | null };
      source: "ai" | "fallback";
    };
    context: {
      memories: Array<{
        memoryId: string;
        title: string | null;
        snippet: string;
        memoryType: string;
        createdAt: string;
        provenance: { reason: string; relevance: number };
      }>;
      entities: Array<{ entityId: string; name: string; type: string }>;
      uncertainties: string[];
      ambiguity: Array<{
        mention: string;
        candidates: Array<{ entityId: string; name: string; type: string }>;
      }>;
      run: { planIterations: number; semantic: string };
    };
    answer: {
      answer: string;
      claims: Array<{ text: string; type: "fact" | "inference"; memoryIds: string[] }>;
      supportingMemoryIds: string[];
      supportingMemoryCount: number;
      uncertainties: string[];
      answerStyle: "direct" | "summary" | "timeline" | "comparison" | "clarification" | "no_evidence";
      verification: { status: "passed" | "regenerated" | "conservative" | "deterministic"; issues: string[] };
      source: "ai" | "deterministic";
    };
    action?:
      | { kind: "captured"; memoryId: string; title: string | null }
      | { kind: "deleted"; memoryId: string; title: string | null }
      | { kind: "delete_clarification"; candidateMemoryIds: string[] };
  };
  error?: { code: string; message: string };
}

export interface AskBoxProps {
  /** Chat scope (Phase 5): focus the conversation on one thing. */
  scope?: "global" | "memory" | "entity" | "topic";
  /** The focused memory/entity/topic id, when scoped. */
  scopeId?: string | null;
  /** Placeholder override for scoped boxes. */
  placeholder?: string;
}

export function AskBox({ scope = "global", scopeId = null, placeholder }: AskBoxProps) {
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse["data"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<string>("");
  const requestSeq = useRef(0);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || pending) return;

      const seq = ++requestSeq.current;
      setPending(true);
      setError(null);
      setQuestion(trimmed);
      setMessage("");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, conversationId, scope, scopeId }),
        });
        const payload: AskResponse = await response.json();

        if (seq !== requestSeq.current) return; // a newer question superseded this one

        if (!response.ok || !payload.ok || !payload.data) {
          setError(payload.error?.message ?? "Something went wrong while putting those memories together. Try again.");
          setResult(null);
        } else {
          setResult(payload.data);
          setConversationId(payload.data.conversationId);
        }
      } catch {
        if (seq === requestSeq.current) {
          setError("Something went wrong while putting those memories together. Try again.");
          setResult(null);
        }
      } finally {
        if (seq === requestSeq.current) setPending(false);
      }
    },
    [conversationId, pending, scope, scopeId]
  );

  const retry = useCallback(() => {
    if (question !== "") void ask(question);
  }, [ask, question]);

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(message);
        }}
        className="space-y-3"
      >
        <label htmlFor={`ask-input-${scope}`} className="sr-only">
          Ask your memory
        </label>
        <textarea
          id={`ask-input-${scope}`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask(message);
            }
          }}
          rows={2}
          placeholder={
            placeholder ?? (question === "" ? "Ask in your own words…" : "Ask a follow-up…")
          }
          className={cn(
            "w-full resize-none rounded-lg border border-border bg-card px-4 py-3 text-[15px] leading-relaxed text-foreground shadow-xs",
            "placeholder:text-muted-foreground/50",
            "focus:border-clay/40 focus:outline-none focus:ring-4 focus:ring-clay/10"
          )}
        />
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
            Enter to ask · Shift+Enter for a new line
          </p>
          {message.trim() !== "" && (
            <Button
              type="submit"
              size="sm"
              disabled={pending}
              className="h-8 bg-clay text-primary-foreground shadow-xs hover:bg-clay-strong"
            >
              {pending ? "Asking…" : "Ask"}
            </Button>
          )}
        </div>
      </form>

      {error && (
        <div role="alert" className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-l-2 border-destructive/50 pl-4">
          <p className="text-sm text-destructive">{error}</p>
          {question !== "" && (
            <button
              type="button"
              onClick={retry}
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-clay underline-offset-4 hover:underline"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {pending && (
        <div className="mt-10 flex items-center gap-1.5" aria-live="polite">
          <span className="sr-only">Reading your memories…</span>
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50"
              style={{ animationDelay: `${dot * 220}ms` }}
            />
          ))}
          <span className="ml-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            Reading your memories…
          </span>
        </div>
      )}

      {result && !pending && (
        <div className="mt-12">
          {/* What was asked — echoed in the display voice. */}
          <p className="font-display text-xl font-medium leading-snug text-foreground">
            {question}
          </p>

          <AskResultBody result={result} onRetryAsk={(text) => void ask(text)} />
        </div>
      )}
    </div>
  );
}

function AskResultBody({
  result,
  onRetryAsk,
}: {
  result: NonNullable<AskResponse["data"]>;
  onRetryAsk?: (text: string) => void;
}) {
  const { context, understanding, answer, action } = result;

  // The memories the answer stands on — provenance you can open.
  const supporting = answer.supportingMemoryIds
    .map((id) => context.memories.find((memory) => memory.memoryId === id))
    .filter((memory): memory is NonNullable<typeof memory> => Boolean(memory));

  return (
    <div className="mt-8">
      {/* What Kept understood — quiet, inspectable, no mystique. */}
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
        understood as · {understanding.intent}
        {understanding.time.kind !== "none" && understanding.time.from && understanding.time.to
          ? ` · ${formatDate(new Date(understanding.time.from))} – ${formatDate(new Date(understanding.time.to))}${understanding.time.uncertain ? " (approximate)" : ""}`
          : ""}
        {context.run.planIterations > 1 ? ` · searched again, wider (attempt ${context.run.planIterations})` : ""}
      </p>

      {/* The answer itself — prose, in the reading voice. */}
      <AnswerProse text={answer.answer} />

      {/* An in-chat capture: what happened, and where it now lives. */}
      {action?.kind === "captured" && (
        <p className="mt-5 text-sm text-muted-foreground">
          Kept in your memories —{" "}
          <Link href={`/memories/${action.memoryId}`} className="text-clay underline-offset-4 hover:underline">
            {action.title ?? "open it"}
          </Link>
          .
        </p>
      )}

      {/* Provenance: subtle, inspectable, honest (spec §21–22). */}
      {supporting.length > 0 && (
        <div className="mt-8 border-t border-border/60 pt-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
            Based on {supporting.length} {supporting.length === 1 ? "memory" : "memories"}
          </p>
          <details className="group mt-3">
            <summary className="inline-block cursor-pointer list-none text-sm text-clay underline-offset-4 hover:underline">
              View the memories behind this
              <span className="ml-2 inline-block transition-transform duration-200 group-open:rotate-90">→</span>
            </summary>
            <div className="mt-4 divide-y divide-border/60">
              {supporting.map((memory) => (
                <Link key={memory.memoryId} href={`/memories/${memory.memoryId}`} className="group block py-4 first:pt-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="font-display text-base font-medium leading-snug text-foreground transition-colors duration-200 group-hover:text-clay">
                      {memory.title ?? "Untitled"}
                    </h3>
                    <time
                      dateTime={memory.createdAt}
                      className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
                    >
                      {formatDate(new Date(memory.createdAt))}
                    </time>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{memory.snippet}</p>
                </Link>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Ambiguity — safe, named, resolvable. */}
      {context.ambiguity.map((entry) => (
        <p
          key={entry.mention}
          className="mt-4 border-l-2 border-clay/50 pl-4 text-sm leading-relaxed text-foreground"
        >
          More than one {entry.candidates[0]?.type ?? "thing"} named “{entry.mention}”. Kept searched
          each separately:{" "}
          {entry.candidates.map((candidate, index) => (
            <span key={candidate.entityId}>
              {index > 0 && ", "}
              <Link
                href={`/search?entity=${candidate.entityId}`}
                className="text-clay underline-offset-4 hover:underline"
              >
                {candidate.name}
              </Link>
            </span>
          ))}
          .
        </p>
      ))}

      {/* Everything else the search surfaced, when it adds something. */}
      {context.memories.length > supporting.length && answer.supportingMemoryCount > 0 && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          The search also surfaced {context.memories.length - supporting.length}{" "}
          {context.memories.length - supporting.length === 1 ? "memory" : "memories"} nearby —{" "}
          <Link href="/memories" className="text-clay underline-offset-4 hover:underline">
            browse everything
          </Link>
          .
        </p>
      )}

      {/* Uncertainties — approximation and fallbacks, named. */}
      {[...answer.uncertainties, ...context.uncertainties].length > 0 && (
        <div className="mt-8 space-y-1.5 border-t border-border/60 pt-6">
          {[...new Set([...answer.uncertainties, ...context.uncertainties])].map((uncertainty, index) => (
            <p
              key={index}
              className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60"
            >
              {uncertainty}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The answer text, rendered calmly: paragraphs, and "•" bullet lines
 * for timelines/lists. No markdown machinery — the model's plain prose
 * is the interface.
 */
function AnswerProse({ text }: { text: string }) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const paragraphs: string[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length > 0) {
      paragraphs.push(`__BULLETS__${bullets.join("\n")}`);
      bullets = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("•") || line.startsWith("-") || line.startsWith("–")) {
      bullets.push(line.replace(/^[•\-–]\s*/, ""));
    } else {
      flushBullets();
      paragraphs.push(line);
    }
  }
  flushBullets();

  return (
    <div className="mt-5 space-y-4">
      {paragraphs.map((paragraph, index) => {
        if (paragraph.startsWith("__BULLETS__")) {
          const items = paragraph.replace("__BULLETS__", "").split("\n");
          return (
            <ul key={index} className="space-y-2 pl-1">
              {items.map((item, itemIndex) => (
                <li key={itemIndex} className="flex gap-3 text-[15px] leading-relaxed text-foreground">
                  <span aria-hidden="true" className="mt-[9px] size-1 shrink-0 rounded-full bg-clay" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="text-[15px] leading-relaxed text-foreground">
            {paragraph}
          </p>
        );
      })}
    </div>
  );
}
