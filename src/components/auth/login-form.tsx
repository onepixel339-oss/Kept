"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * LoginForm — email and password, nothing else.
 *
 * Errors are spoken plainly ("That email and password don't match an
 * account.") — the same words whether the email is unknown or the
 * password is wrong, because the server answers the same way either
 * way. Rate limits surface honestly when they trip.
 */

const fieldLabel =
  "font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground";

export function LoginForm() {
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
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await response.json().catch(() => undefined);

      if (!response.ok || !json?.ok) {
        setError(json?.error?.message ?? "Signing in didn't work — try again.");
        setStatus("error");
        return;
      }

      // The session cookie is set; the archive is where we left it.
      router.replace("/");
      router.refresh();
    } catch {
      setError("The space is unreachable — check your connection.");
      setStatus("error");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label htmlFor="login-email" className={fieldLabel}>
          Email
        </label>
        <Input
          id="login-email"
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
        <label htmlFor="login-password" className={fieldLabel}>
          Password
        </label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          className="h-11 border-border/80 bg-background focus-visible:ring-clay"
        />
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
        {status === "working" ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function LoginFooterLink() {
  return (
    <span>
      New here?{" "}
      <Link href="/signup" className="text-clay hover:text-clay-strong">
        Create an account
      </Link>
    </span>
  );
}
