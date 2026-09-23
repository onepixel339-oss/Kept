"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shared/error-state";

/**
 * Global error boundary — the product's calm failure face.
 * Renders inside the shell, so the masthead and footer still hold.
 */
export default function MemoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logged for the operator; never shown to the user in raw form.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6">
      <ErrorState onRetry={reset} />
    </div>
  );
}
