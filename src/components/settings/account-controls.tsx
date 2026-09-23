"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * SignOutButton — ends the session server-side, then leaves.
 */

const fieldLabel =
  "font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function signOut() {
    if (working) return;
    setWorking(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch {
      setWorking(false);
    }
  }

  return (
    <Button
      variant="ghost"
      onClick={signOut}
      disabled={working}
      className={
        className ??
        "h-8 gap-1.5 px-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
      }
    >
      <LogOut aria-hidden="true" className="size-3.5" />
      {working ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/**
 * PasswordForm — change the account password. Requires the current
 * password; every other session ends. Spoken plainly on failure.
 */
export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "working") return;
    setStatus("working");
    setError(null);

    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await response.json().catch(() => undefined);

      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "The password couldn't be changed.");
        setStatus("error");
        return;
      }

      setCurrentPassword("");
      setNewPassword("");
      setStatus("done");
    } catch {
      setError("The space is unreachable — check your connection.");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 max-w-sm space-y-4" noValidate>
      <div className="space-y-2">
        <label htmlFor="current-password" className={fieldLabel}>
          Current password
        </label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="h-10 border-border/80 bg-background focus-visible:ring-clay"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="new-password" className={fieldLabel}>
          New password
        </label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="h-10 border-border/80 bg-background focus-visible:ring-clay"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {error}
        </p>
      )}
      {status === "done" && (
        <p role="status" className="text-sm leading-relaxed text-foreground">
          Password changed. Other signed-in devices were signed out.
        </p>
      )}

      <Button
        type="submit"
        disabled={status === "working"}
        variant="outline"
        className="h-10 border-border/80 px-5 hover:bg-clay-soft/60"
      >
        {status === "working" ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
