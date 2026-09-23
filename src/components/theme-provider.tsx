"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Theme provider — light by default (warm paper is the identity),
 * dark available and designed with the same care. Class-based so the
 * tokens in globals.css apply cleanly.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
