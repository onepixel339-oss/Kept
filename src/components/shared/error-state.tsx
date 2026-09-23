"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Error state — calm, specific, and never blame-throwing.
 *
 * The message assumes something went wrong on OUR side, tells the user
 * what to try next, and always offers a way forward.
 */
export function ErrorState({
  title = "Something went wrong",
  description = "This isn't your doing — the space stumbled for a moment. Trying again usually settles it.",
  onRetry,
  children,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center sm:py-20",
        className
      )}
      role="alert"
    >
      <h3 className="font-display text-xl font-medium text-foreground">{title}</h3>
      <p className="mt-2.5 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-6 gap-2 border-border text-foreground shadow-xs hover:bg-secondary"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Try again
        </Button>
      )}
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
