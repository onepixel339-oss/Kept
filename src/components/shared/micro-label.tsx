import { cn } from "@/lib/utils";

/**
 * Micro-label — the annotation voice of the interface.
 *
 * Small mono uppercase labels that organize a page the way a book uses
 * running heads and folios. Never shouting, always tracking wide.
 */
export function MicroLabel({
  children,
  className,
  as: Tag = "p",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "p" | "span" | "h1" | "h2" | "h3" | "h4";
}) {
  return (
    <Tag
      className={cn(
        "font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className
      )}
    >
      {children}
    </Tag>
  );
}
