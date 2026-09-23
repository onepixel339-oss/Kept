"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download, ExternalLink, FileText, Image as ImageIcon, Link2, Mic, RotateCcw } from "lucide-react";
import { MicroLabel } from "@/components/shared/micro-label";
import { cn } from "@/lib/utils";
import type { SourceView } from "@/types/source";

/**
 * Memory sources (Phase 9 §27) — where this memory came from.
 *
 * The user may inspect the original image, hear the recording, open
 * the link, or download the file, and read exactly what was extracted
 * from it — nothing more, nothing less. Model internals and storage
 * paths do not exist here. Failure states are quiet lines with a
 * retry, never alarms.
 */

const SOURCE_LABEL: Record<string, string> = {
  user_input: "Your words",
  image: "Image",
  voice: "Recording",
  file: "File",
  url: "Link",
  conversation: "Conversation",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "",
  partial: "partially read",
  pending: "waiting to be read",
  processing: "being read",
  failed: "couldn't be read",
};

export function MemorySources({ sources }: { sources: SourceView[] }) {
  if (sources.length === 0) return null;
  return (
    <section className="mt-10 border-t border-border/60 pt-8">
      <MicroLabel as="h2">Where it came from</MicroLabel>
      <ul className="mt-4 space-y-3">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} />
        ))}
      </ul>
    </section>
  );
}

function SourceRow({ source }: { source: SourceView }) {
  const [open, setOpen] = useState(false);
  const hasExtractedText = source.content !== null && source.content !== "";

  return (
    <li className="rounded-lg border border-border/60 bg-card/50">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/60 text-muted-foreground">
          {source.sourceType === "image" ? (
            source.hasThumbnail ? (
              // Authenticated, ownership-checked access — never a public URL.
               
              <img
                src={`/api/sources/${source.id}/file?variant=thumb`}
                alt={source.label ? `Thumbnail of ${source.label}` : "Thumbnail of the kept image"}
                className="size-9 rounded-md object-cover"
                loading="lazy"
              />
            ) : (
              <ImageIcon aria-hidden="true" className="size-4" />
            )
          ) : source.sourceType === "voice" ? (
            <Mic aria-hidden="true" className="size-4" />
          ) : source.sourceType === "url" ? (
            <Link2 aria-hidden="true" className="size-4" />
          ) : source.sourceType === "file" ? (
            <FileText aria-hidden="true" className="size-4" />
          ) : (
            <span className="font-mono text-[10px] uppercase">Aa</span>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">
            {source.label ?? SOURCE_LABEL[source.sourceType] ?? "Source"}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
            {SOURCE_LABEL[source.sourceType] ?? source.sourceType}
            {source.extractionStatus !== "ready" && source.extractionStatus !== "processing"
              ? ` · ${STATUS_LABEL[source.extractionStatus] ?? source.extractionStatus}`
              : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {source.sourceType === "url" && source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title="Open the original link"
              aria-label="Open the original link"
              className="rounded-md p-2 text-muted-foreground transition-colors duration-200 hover:bg-secondary hover:text-foreground"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          )}
          {source.hasOriginal && (
            <a
              href={`/api/sources/${source.id}/file${source.sourceType === "file" || source.sourceType === "voice" ? "?download=1" : ""}`}
              target={source.sourceType === "file" || source.sourceType === "voice" ? undefined : "_blank"}
              rel="noopener noreferrer"
              title={source.sourceType === "file" ? "Download the original" : "View the original"}
              aria-label={source.sourceType === "file" ? "Download the original" : "View the original"}
              className="rounded-md p-2 text-muted-foreground transition-colors duration-200 hover:bg-secondary hover:text-foreground"
            >
              {source.sourceType === "file" ? <Download aria-hidden="true" className="size-3.5" /> : <ExternalLink aria-hidden="true" className="size-3.5" />}
            </a>
          )}
          {hasExtractedText && (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              title={open ? "Hide what was read" : "Show what was read"}
              className="rounded-md p-2 text-muted-foreground transition-colors duration-200 hover:bg-secondary hover:text-foreground"
            >
              <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
            </button>
          )}
        </div>
      </div>

      {source.sourceType === "voice" && source.hasOriginal && (
        <div className="border-t border-border/50 px-3 py-2.5">
          {/* The original recording — the transcript is a second thing, never a replacement. */}
          <audio controls preload="none" src={`/api/sources/${source.id}/file`} className="h-9 w-full">
            <track kind="captions" />
          </audio>
        </div>
      )}

      {(source.extractionStatus === "failed" || source.extractionStatus === "pending") && (
        <div className="border-t border-border/50 px-3 py-2.5">
          <SourceRetry sourceId={source.id} />
          {source.extractionError && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{source.extractionError}</p>
          )}
        </div>
      )}

      {source.extractionStatus === "partial" && source.extractionError && (
        <div className="border-t border-border/50 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{source.extractionError}</p>
        </div>
      )}

      {open && hasExtractedText && (
        <div className="border-t border-border/50 px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
            What was read from it
          </p>
          <p className="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
            {source.content}
          </p>
        </div>
      )}
    </li>
  );
}

function SourceRetry({ sourceId }: { sourceId: string }) {
  const [retrying, setRetrying] = useState(false);
  const router = useRouter();

  return (
    <button
      type="button"
      disabled={retrying}
      onClick={async () => {
        setRetrying(true);
        try {
          await fetch(`/api/sources/${sourceId}/retry`, { method: "POST" });
          router.refresh();
        } finally {
          setRetrying(false);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:text-foreground hover:decoration-clay disabled:opacity-60"
    >
      <RotateCcw aria-hidden="true" className={cn("size-3", retrying && "animate-spin")} />
      Try reading it again
    </button>
  );
}
