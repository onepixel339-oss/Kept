import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Empty state — quiet honesty, not an apology.
 *
 * Used wherever a collection has nothing in it yet. The tone is calm
 * and forward-looking; the design is typographic, with no cards and
 * no noise.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center sm:py-20",
        className
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          strokeWidth={1.5}
          className="mb-5 size-8 text-clay/70"
        />
      )}
      <h3 className="font-display text-xl font-medium text-foreground">
        {title}
      </h3>
      {description && (
        <p className="mt-2.5 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
