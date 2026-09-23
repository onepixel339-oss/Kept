import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm, SignupFooterLink } from "@/components/auth/signup-form";
import { getCurrentUser } from "@/modules/user";

export const metadata: Metadata = {
  title: "Create your account",
};

/**
 * /signup — the beginning of an archive.
 */
export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  return (
    <AuthShell
      label="A quiet place to keep what matters"
      title={
        <>
          Create your <em className="italic text-clay">Kept</em> account.
        </>
      }
      description="One account, your memories, no one else's. What you keep stays yours — exportable, deletable, always."
      footer={<SignupFooterLink />}
    >
      <SignupForm />
    </AuthShell>
  );
}
