import Link from "next/link";
import type { Metadata } from "next";
import { Feather, Bookmark, Compass } from "lucide-react";
import { MicroLabel } from "@/components/shared/micro-label";
import { Button } from "@/components/ui/button";
import { requirePageUser } from "@/modules/user";

export const metadata: Metadata = {
  title: "Welcome",
};

/**
 * /welcome — onboarding, in three calm sentences.
 *
 * No tutorial, no AI marketing: what this space is, what you do with
 * it, and what it will quietly do for you later. Reached once, after
 * signup; visiting it again is harmless.
 */

const steps = [
  {
    icon: Bookmark,
    label: "Yours",
    text: "Your memories stay yours. Nothing here is shared, ranked, or shown to anyone else.",
  },
  {
    icon: Feather,
    label: "Keep",
    text: "Save something you want to remember — in your own words, the way you'd tell a friend.",
  },
  {
    icon: Compass,
    label: "Rediscover",
    text: "Later you can explore and talk about it — people, topics, a timeline, and plain questions.",
  },
];

export default async function WelcomePage() {
  await requirePageUser();

  return (
    <div className="mx-auto w-full max-w-xl px-6">
      <div className="pb-24 pt-16 sm:pt-24">
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-700">
          <MicroLabel>Welcome to Kept</MicroLabel>
          <h1 className="mt-4 font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
            A quiet place to <em className="italic text-clay">keep</em> what
            matters.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Three things worth knowing before you begin.
          </p>
        </div>

        <ol className="mt-12 space-y-10 border-t border-border/60 pt-10">
          {steps.map((step, index) => (
            <li
              key={step.label}
              className="flex gap-5 animate-in fade-in slide-in-from-bottom-2 duration-700"
              style={{ animationDelay: `${150 * (index + 1)}ms` }}
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-clay-soft/60">
                <step.icon aria-hidden="true" className="size-4 text-clay" />
              </span>
              <div>
                <MicroLabel as="h2">{step.label}</MicroLabel>
                <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
                  {step.text}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-14 border-t border-border/60 pt-8">
          <Button
            asChild
            className="h-11 bg-clay px-6 text-[15px] text-white hover:bg-clay-strong"
          >
            <Link href="/">Start keeping</Link>
          </Button>
          <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
            You can export everything, or delete your account and every memory
            with it, any time — from Settings.
          </p>
        </div>
      </div>
    </div>
  );
}
