import type { Metadata, Viewport } from "next";
import { Fraunces, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { appConfig } from "@/config/app";
import { getCurrentUser } from "@/modules/user";

/*
 * Typography does the heavy lifting in Kept:
 *  - Fraunces speaks (display serif — headings, moments of voice)
 *  - Inter works (body and interface)
 *  - Geist Mono annotates (micro-labels, metadata, timestamps)
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: `${appConfig.name} — ${appConfig.tagline}`,
    template: `%s — ${appConfig.name}`,
  },
  description: appConfig.description,
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: appConfig.name,
    description: appConfig.tagline,
    siteName: appConfig.name,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
    { media: "(prefers-color-scheme: dark)", color: "#26221e" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // One session lookup for the whole shell — the header speaks the
  // signed-in truth (email + sign-out) or stays quiet.
  const user = await getCurrentUser();

  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body
        className={`${fraunces.variable} ${inter.variable} ${geistMono.variable} flex min-h-svh flex-col bg-background font-sans text-foreground antialiased`}
      >
        <ThemeProvider>
          <SiteHeader userEmail={user?.email ?? null} />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
