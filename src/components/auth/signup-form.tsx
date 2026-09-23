"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * SignupForm — one email, one password, one quiet promise: what you
 * keep here is yours. Password policy is honest and short: at least
 * 8 characters.
 */

const fieldLabel =
  "font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "working") return;
    setStatus("working");
    setError(null);

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await response.json().catch(() => undefined);

      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "Creating the account didn't work — try again.");
        setStatus("error");
        return;
      }

      // Straight into the calmest possible beginning.
      router.replace("/welcome");
      router.refresh();
    } catch {
      setError("The space is unreachable — check your connection.");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label htmlFor="signup-email" className={fieldLabel}>
          Email
        </label>
        <Input
          id="signup-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="h-11 border-border/80 bg-background focus-visible:ring-clay"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="signup-password" className={fieldLabel}>
          Password
        </label>
        <Input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="h-11 border-border/80 bg-background focus-visible:ring-clay"
        />
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          At least 8 characters. It&apos;s stored hashed — we can&apos;t read it.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={status === "working"}
        className="h-11 w-full bg-clay text-[15px] text-white hover:bg-clay-strong"
      >
        {status === "working" ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

export function SignupFooterLink() {
  return (
    <span>
      Already keeping memories?{" "}
      <Link href="/login" className="text-clay hover:text-clay-strong">
        Sign in
      </Link>
    </span>
  );
}
