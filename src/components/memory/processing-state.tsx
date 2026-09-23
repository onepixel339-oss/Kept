import type { ProcessingStatus } from "@/types/processing";
import { cn } from "@/lib/utils";

/**
 * ProcessingState — a whisper of status, never a dashboard.
 *
 * The AI is invisible here by design: "processing" is all the user
 * ever needs to know, and "couldn't finish processing" is the only
 * failure they ever see. No model names, no confidence numbers, no
 * progress bars.
 */

const LABELS: Record<ProcessingStatus, string | null> = {
  pending: "Processing",
  processing: "Processing",
  ready: null, // ready is the quiet default — nothing to announce
  failed: "Couldn't finish processing",
};

export function processingLabel(status: ProcessingStatus): string | null {
  return LABELS[status];
}

export function ProcessingState({ status }: { status: ProcessingStatus }) {
  const label = LABELS[status];
  if (!label) return null;

  const failed = status === "failed";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]",
        failed ? "text-clay-strong" : "text-muted-foreground/60"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          failed ? "bg-clay-strong/70" : "animate-pulse bg-clay/60"
        )}
      />
      {label}
    </span>
  );
}
