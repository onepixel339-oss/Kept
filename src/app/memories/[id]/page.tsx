import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MemoryDelete } from "@/components/memory/memory-delete";
import { MemoryEditor } from "@/components/memory/memory-editor";
import { MemorySources } from "@/components/memory/memory-sources";
import { ProcessingRetry } from "@/components/memory/processing-retry";
import { ProcessingState } from "@/components/memory/processing-state";
import { VersionHistory } from "@/components/memory/version-history";
import { AskBox } from "@/components/ask/ask-box";
import { MicroLabel } from "@/components/shared/micro-label";
import { requirePageUser } from "@/modules/user";
import { findMemory, getMemoryVersions } from "@/modules/memory";
import { listMemorySources, toSourceView } from "@/modules/ingestion";
import { getMemoryGraph } from "@/modules/entity";
import { getSimilarMemories } from "@/modules/exploration";
import { findLatestAnalysis } from "@/modules/intelligence";
import { entityHref } from "@/lib/entity-links";
import { formatDate, snippet } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * MemoryDetail — one memory, read the way it was written.
 *
 * The original content is the page's center of gravity. Understanding
 * (summary, entities, connections) sits quietly around it and is
 * labeled for what it is: gathered from the user's words, never a
 * replacement for them. Processing state appears only when there is
 * something honest to say. Version history opens on demand.
 */

export default async function MemoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = (await requirePageUser()).id;
  const memory = userId ? await findMemory(userId, id) : null;

  // Another user's memory is a memory that does not exist.
  if (!memory) {
    notFound();
  }

  const [graph, versions, analysis, similar, sources] = await Promise.all([
    getMemoryGraph(userId!, memory.id),
    getMemoryVersions(userId!, memory.id),
    findLatestAnalysis(userId!, memory.id),
    getSimilarMemories(userId!, memory.id, 6),
    listMemorySources(userId!, memory.id),
  ]);
  const sourceViews = sources.map(toSourceView);

  const relatedMemories: Array<{ label: string; relationType: string; memoryId: string }> = [];
  for (const entry of graph.relations) {
    const { relation } = entry;
    // Only relations whose other end is a memory belong on this page.
    if (relation.sourceType === "memory" && relation.sourceId !== memory.id) {
      if (entry.sourceLabel) {
        relatedMemories.push({ label: entry.sourceLabel, relationType: relation.relationType, memoryId: relation.sourceId });
      }
    } else if (relation.targetType === "memory" && relation.targetId !== memory.id) {
      if (entry.targetLabel) {
        relatedMemories.push({ label: entry.targetLabel, relationType: relation.relationType, memoryId: relation.targetId });
      }
    }
  }

  const displayTitle = (memory.title ?? snippet(memory.originalContent, 80)) || "Untitled";

  // Honest provenance: when the current summary is exactly what the
  // last successful understanding proposed, say so — quietly. If the
  // user has since written their own, the caption stays silent.
  const analysisData =
    analysis?.status === "succeeded" && analysis.decisionJson
      ? (JSON.parse(analysis.decisionJson) as { applied?: { enriched?: boolean } })
      : null;
  const summaryFromSystem =
    Boolean(memory.summary) &&
    analysis?.status === "succeeded" &&
    analysisData?.applied?.enriched === true &&
    analysis.analysisJson
      ? (JSON.parse(analysis.analysisJson) as {
          candidate?: { summary?: string };
        })?.candidate?.summary === memory.summary
      : false;

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      {/* ————— Back and actions ————— */}
      <div className="flex items-center justify-between pb-10 pt-10 sm:pt-14">
        <Link
          href="/memories"
          className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-3 transition-transform duration-200 group-hover:-translate-x-0.5" />
          Memories
        </Link>
        <div className="flex items-center gap-1">
          <MemoryEditor
            memory={{
              id: memory.id,
              title: memory.title,
              originalContent: memory.originalContent,
              summary: memory.summary,
              memoryType: memory.memoryType,
              rememberedAt: memory.rememberedAt ? memory.rememberedAt.toISOString() : null,
            }}
          />
          <MemoryDelete memoryId={memory.id} />
        </div>
      </div>

      {/* ————— The memory ————— */}
      <article className="animate-in fade-in slide-in-from-bottom-2 duration-700">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
          {memory.memoryType}
          {memory.rememberedAt && ` · remembered ${formatDate(memory.rememberedAt)}`}
          {` · kept ${formatDate(memory.createdAt)}`}
          {memory.status !== "active" && ` · ${memory.status}`}
        </p>

        <h1 className="mt-4 font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
          {displayTitle}
        </h1>

        {/* Processing whisper — only when there is something honest to say. */}
        {(memory.processingStatus === "pending" ||
          memory.processingStatus === "processing" ||
          memory.processingStatus === "failed") && (
          <div className="mt-4">
            <ProcessingState status={memory.processingStatus} />
            {memory.processingStatus !== "processing" && (
              <ProcessingRetry memoryId={memory.id} />
            )}
          </div>
        )}

        {/* The user's own words — the reason this page exists. */}
        <div className="mt-8 whitespace-pre-wrap text-[16px] leading-[1.8] text-foreground sm:text-[17px]">
          {memory.originalContent}
        </div>

        {memory.summary && (
          <div className="mt-10 border-l-2 border-clay/50 pl-4">
            <MicroLabel>Summary</MicroLabel>
            {summaryFromSystem && (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                Gathered from your words
              </p>
            )}
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {memory.summary}
            </p>
          </div>
        )}
      </article>

      {/* ————— Where it came from (rich provenance, Phase 9) ————— */}
      <MemorySources sources={sourceViews} />

      {/* ————— People & things ————— */}
      {graph.links.length > 0 && (
        <section className="mt-14 border-t border-border/60 pt-8">
          <MicroLabel as="h2">People &amp; things</MicroLabel>
          <p className="mt-3 text-sm leading-relaxed text-foreground">
            {graph.links.map((link, index) => (
              <span key={link.entity.id}>
                {index > 0 && <span className="text-muted-foreground/50"> · </span>}
                <Link
                  href={entityHref(link.entity)}
                  className="underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                >
                  {link.entity.name}
                </Link>
                <span
                  className={cn(
                    "font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60"
                  )}
                >
                  {" "}
                  {link.entity.type}
                  {link.role !== "mentioned" && ` · ${link.role}`}
                </span>
              </span>
            ))}
          </p>
        </section>
      )}

      {/* ————— Related memories ————— */}
      {relatedMemories.length > 0 && (
        <section className="mt-10 border-t border-border/60 pt-8">
          <MicroLabel as="h2">Related memories</MicroLabel>
          <ul className="mt-3 space-y-2.5">
            {relatedMemories.map((entry) => (
              <li key={`${entry.memoryId}-${entry.relationType}`} className="flex items-baseline gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  {entry.relationType.replace(/_/g, " ")}
                </span>
                <Link
                  href={`/memories/${entry.memoryId}`}
                  className="text-sm text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ————— More like this (shared saved things, spec §9) ————— */}
      {similar.length > 0 && (
        <section className="mt-10 border-t border-border/60 pt-8">
          <MicroLabel as="h2">More like this</MicroLabel>
          <ul className="mt-3 space-y-2.5">
            {similar.map((entry) => (
              <li key={entry.memoryId} className="flex items-baseline gap-3">
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  shares {entry.shared.map((entity) => entity.name).join(" · ")}
                </span>
                <Link
                  href={`/memories/${entry.memoryId}`}
                  className="text-sm text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:decoration-clay"
                >
                  {entry.title ?? "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ————— History ————— */}
      {versions.length > 1 && (
        <section className="mt-10 border-t border-border/60 pt-8">
          <MicroLabel as="h2">History</MicroLabel>
          <div className="mt-4">
            <VersionHistory versions={versions} />
          </div>
        </section>
      )}

      {/* ————— Ask about this memory (memory-scoped chat, spec §10) ————— */}
      <section className="mt-14 border-t border-border/60 pb-24 pt-8">
        <MicroLabel as="h2">Ask about this memory</MicroLabel>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          &ldquo;What happened before this?&rdquo; &ldquo;إيه علاقته بالمشروع؟&rdquo; — the
          conversation starts here, and can reach the memories around it.
        </p>
        <div className="mt-6">
          <AskBox
            scope="memory"
            scopeId={memory.id}
            placeholder="Ask about this memory, or what surrounds it…"
          />
        </div>
      </section>
    </div>
  );
}
