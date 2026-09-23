"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * MemoryDelete — a real decision gets a real confirmation.
 *
 * Deleting removes the memory, its version history, its entity links,
 * and the relations touching it. Entities survive. The dialog says
 * this plainly, in the product's voice.
 */
export function MemoryDelete({ memoryId }: { memoryId: string }) {
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function remove() {
    if (deleting) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/memories/${memoryId}`, { method: "DELETE" });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        setDeleting(false);
        setOpen(false);
        return;
      }
      router.push("/memories");
      router.refresh();
    } catch {
      setDeleting(false);
      setOpen(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-destructive/5 hover:text-destructive"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-border bg-background sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-xl font-medium">
            Let this memory go?
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-relaxed text-muted-foreground">
            This removes the memory, its history, and its connections.
            Things it mentions stay — they may belong to other memories.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="rounded-lg border-border bg-transparent text-sm text-foreground hover:bg-secondary">
            Keep it
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void remove()}
            disabled={deleting}
            className="rounded-lg bg-destructive text-sm text-white hover:bg-destructive/90"
          >
            {deleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
