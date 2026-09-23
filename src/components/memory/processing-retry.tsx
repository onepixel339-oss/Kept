"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * ProcessingRetry — the honest invitation to try again.
 *
 * Shown only when processing didn't finish ("failed") or hasn't run
 * yet for an older memory ("pending"). The wording never mentions AI,
 * never promises understanding — it just offers to finish the job.
 * The memory itself is safe either way; that's the point.
 */
export function ProcessingRetry({ memoryId }: { memoryId: string }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(`/api/memories/${memoryId}/process`, {
        method: "POST",
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? "Processing could not finish — try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Processing could not finish — the space is unreachable.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void retry()}
        disabled={retrying}
        className={cnRetry(retrying)}
      >
        <RefreshCw aria-hidden="true" className={cnIcon(retrying)} />
        {retrying ? "Processing…" : "Try processing again"}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function cnRetry(retrying: boolean): string {
  return [
    "h-8 rounded-lg border-border bg-card text-[13px] text-muted-foreground shadow-xs",
    "hover:bg-secondary hover:text-foreground",
    retrying ? "opacity-70" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function cnIcon(retrying: boolean): string {
  return ["size-3.5", retrying ? "animate-spin" : ""].filter(Boolean).join(" ");
}
