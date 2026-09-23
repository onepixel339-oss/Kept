import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { MicroLabel } from "@/components/shared/micro-label";
import {
  PasswordForm,
  SignOutButton,
} from "@/components/settings/account-controls";
import {
  ClaimCard,
  DeleteAccountCard,
  ExportButton,
} from "@/components/settings/data-controls";
import { requirePageUser } from "@/modules/user";
import { countLiveSessions } from "@/modules/user/application/account";
import { previewLegacyClaim } from "@/modules/user/application/data-rights";
import { IDENTITY_COOKIE } from "@/lib/identity";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * /settings — the account's quiet control panel.
 *
 * Four honest sections: Account, Security, Privacy, Data. No internal
 * architecture, no technical dashboard — just what the user can know
 * and do, in the product's own voice.
 */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/60 pb-14 pt-10">
      <MicroLabel as="h2">{title}</MicroLabel>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-[15px] text-foreground">{value}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const user = await requirePageUser();
  const [liveSessions, claim, store] = await Promise.all([
    countLiveSessions(user.id),
    previewLegacyClaim(user.id, (await cookies()).get(IDENTITY_COOKIE)?.value),
    cookies(),
  ]);
  void store;

  return (
    <div className="mx-auto w-full max-w-2xl px-6">
      {/* ————— Account ————— */}
      <section className="pb-14 pt-14 sm:pt-16">
        <MicroLabel>Settings</MicroLabel>
        <h1 className="mt-4 font-display text-3xl font-medium text-foreground">
          Your space, on your terms.
        </h1>
      </section>

      <Section title="Account">
        <div className="divide-y divide-border/40">
          <Fact label="Email" value={user.email ?? "—"} />
          <Fact label="Member since" value={formatDate(user.createdAt)} />
          <Fact
            label="Active sign-ins"
            value={`${liveSessions} ${liveSessions === 1 ? "device" : "devices"}`}
          />
        </div>
      </Section>

      {/* ————— Security ————— */}
      <Section title="Security">
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Your password is stored hashed — nobody can read it, including us.
          Changing it signs out every other device.
        </p>
        <PasswordForm />
        <div className="mt-8 flex items-center gap-4 border-t border-border/40 pt-6">
          <SignOutButton className="h-10 gap-2 rounded-md border border-border/80 px-5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:bg-clay-soft/60 hover:text-foreground" />
          <span className="text-[13px] text-muted-foreground">
            Ends this session on this device.
          </span>
        </div>
      </Section>

      {/* ————— Privacy ————— */}
      <Section title="Privacy">
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          Everything you keep is stored privately, scoped to your account, and
          shown to no one else. AI processing reads only what it needs for the
          memory you ask about — never another account&apos;s, never everything
          at once.
        </p>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
          The plain-language version of what is stored, what processing does,
          and how deletion works:{" "}
          <Link href="/privacy" className="text-clay hover:text-clay-strong">
            Privacy, in plain words
          </Link>
          .
        </p>
      </Section>

      {/* ————— Data ————— */}
      <Section title="Data">
        <h3 className="text-[15px] font-medium text-foreground">
          Export everything
        </h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          A complete JSON copy: memories and their full history, entities,
          relations, sources, and conversations. Yours to keep.
        </p>
        <ExportButton />

        {claim.available && (
          <div className="mt-10 border border-border/60 bg-clay-soft/30 p-5">
            <h3 className="text-[15px] font-medium text-foreground">
              Found data from before accounts
            </h3>
            <ClaimCard />
          </div>
        )}

        <div className="mt-10 border-t border-border/40 pt-8">
          <h3 className="text-[15px] font-medium text-foreground">
            Delete account
          </h3>
          <DeleteAccountCard email={user.email ?? ""} />
        </div>
      </Section>
    </div>
  );
}
