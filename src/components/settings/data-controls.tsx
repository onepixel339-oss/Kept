"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

/**
 * DataRights — export, explicit import, and account deletion.
 *
 * Export downloads a complete JSON copy of the account's data.
 * Claim appears only when the browser carries a valid legacy ticket
 * (pre-account local data), and always acts on an explicit press.
 * Deletion asks for the password and one unambiguous confirmation —
 * it is real, so the ask is real.
 */

export function ExportButton() {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function exportData() {
    if (state === "working") return;
    setState("working");
    setMessage(null);
    try {
      const response = await fetch("/api/export");
      if (!response.ok) {
        const json = await response.json().catch(() => undefined);
        setMessage(json?.error?.message ?? "The export couldn't be prepared.");
        setState("error");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `kept-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setMessage("The space is unreachable — check your connection.");
      setState("error");
    }
  }

  return (
    <div className="mt-4">
      <Button
        onClick={exportData}
        disabled={state === "working"}
        variant="outline"
        className="h-10 gap-2 border-border/80 px-5 hover:bg-clay-soft/60"
      >
        <Download aria-hidden="true" className="size-4" />
        {state === "working" ? "Preparing…" : "Export my data"}
      </Button>
      {message && (
        <p role="alert" className="mt-3 text-sm leading-relaxed text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

export interface ClaimSummary {
  memories: number;
  entities: number;
  mergedEntities: number;
  relations: number;
  sources: number;
  chats: number;
}

export function ClaimCard() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ClaimSummary | null>(null);

  async function claim() {
    if (state === "working") return;
    setState("working");
    setError(null);
    try {
      const response = await fetch("/api/account/claim", { method: "POST" });
      const json = await response.json().catch(() => undefined);
      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "The import didn't work.");
        setState("error");
        return;
      }
      setSummary(json.data.claimed);
      setState("done");
      router.refresh();
    } catch {
      setError("The space is unreachable — check your connection.");
      setState("error");
    }
  }

  if (state === "done" && summary) {
    const parts = [
      `${summary.memories} ${summary.memories === 1 ? "memory" : "memories"}`,
      `${summary.entities} ${summary.entities === 1 ? "entity" : "entities"}`,
      ...(summary.mergedEntities > 0
        ? [`${summary.mergedEntities} merged`]
        : []),
      `${summary.chats} ${summary.chats === 1 ? "conversation" : "conversations"}`,
    ];
    return (
      <p role="status" className="mt-4 text-sm leading-relaxed text-foreground">
        Imported — {parts.join(", ")} now belong to this account.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        This browser holds data kept here before accounts existed. Importing
        moves it into your account — it stays this browser&apos;s history, now
        properly yours.
      </p>
      <Button
        onClick={claim}
        disabled={state === "working"}
        variant="outline"
        className="mt-3 h-10 gap-2 border-border/80 px-5 hover:bg-clay-soft/60"
      >
        <Archive aria-hidden="true" className="size-4" />
        {state === "working" ? "Importing…" : "Import this browser's data"}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-sm leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function DeleteAccountCard({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount() {
    if (state === "working") return;
    setState("working");
    setError(null);
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password }),
      });
      const json = await response.json().catch(() => undefined);
      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "The deletion didn't work.");
        setState("error");
        return;
      }
      // The account is gone; the session is dead. Leave quietly.
      router.replace("/signup");
      router.refresh();
    } catch {
      setError("The space is unreachable — check your connection.");
      setState("error");
    }
  }

  return (
    <>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
        Deleting your account removes every memory, entity, conversation, and
        source that belongs to it — permanently, and only yours. This cannot
        be undone.
      </p>
      <Button
        onClick={() => setOpen(true)}
        variant="ghost"
        className="mt-3 h-10 px-5 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        Delete my account
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="border-border/70 bg-background">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-xl">
              Delete this account and everything in it?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 leading-relaxed">
                <p>
                  <span className="font-mono text-[13px] text-foreground">
                    {email}
                  </span>{" "}
                  will be removed along with every memory it holds. There is
                  no undo, and nothing is kept behind.
                </p>
                <p>Confirm your password to continue.</p>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  className="h-10 border-border/80 bg-background"
                />
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border/80">
              Keep my account
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void deleteAccount();
              }}
              disabled={state === "working" || password.length === 0}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {state === "working" ? "Deleting…" : "Delete forever"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
