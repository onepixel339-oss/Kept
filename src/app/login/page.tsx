import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm, LoginFooterLink } from "@/components/auth/login-form";
import { getCurrentUser } from "@/modules/user";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * /login — the door. Signed-in visitors don't need it.
 */
export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  return (
    <AuthShell
      label="Welcome back"
      title={
        <>
          Sign in to your <em className="italic text-clay">Kept</em> space.
        </>
      }
      description="Your memories are where you left them — kept for you, and yours alone."
      footer={<LoginFooterLink />}
    >
      <LoginForm />
    </AuthShell>
  );
}
