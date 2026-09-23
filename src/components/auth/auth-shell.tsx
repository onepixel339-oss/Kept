import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { MicroLabel } from "@/components/shared/micro-label";
import { cn } from "@/lib/utils";

/**
 * AuthShell — the shared frame of the sign-in and sign-up screens.
 *
 * Same paper, same serif, same quiet hairlines as the rest of Kept.
 * No robots, no gradients, no technical dashboard: authentication is
 * simply the door to the same product.
 */
export function AuthShell({
  label,
  title,
  description,
  children,
  footer,
  className,
}: {
  label: string;
  title: React.ReactNode;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-md px-6", className)}>
      <div className="pb-16 pt-14 sm:pt-20">
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-700">
          <Wordmark />

          <div className="mt-10">
            <MicroLabel>{label}</MicroLabel>
            <h1 className="mt-4 font-display text-3xl font-medium leading-tight text-foreground">
              {title}
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="mt-8">{children}</div>

          {footer && (
            <div className="mt-8 border-t border-border/60 pt-6 text-sm text-muted-foreground">
              {footer}
            </div>
          )}

          <p className="mt-10 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <Link
              href="/privacy"
              className="transition-colors hover:text-foreground"
            >
              What Kept stores, and why
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
