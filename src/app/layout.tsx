import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-space-grotesk", // keeping the variable name the same so we don't break tailwind config if hardcoded
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Orchestra",
  description: "Advanced Agentic Swarm Platform",
};

// PM #15 — pre-paint dark-mode bootstrap.
//
// Earlier this layout awaited the settings store to compute the initial
// `<html className="dark">` class. That triggered Next.js dev-mode RSC
// instrumentation to capture the `fs.readFile` of `data/settings/settings.json`
// — INCLUDING the `auth.passwordHash` field — into the HTML stream of every
// page that uses the root layout, which includes the unauthenticated
// `/login` route. Anyone able to `curl /login` walked away with an
// offline-bruteforceable scrypt hash. Confirmed in production-shaped audit.
//
// Fix: don't read any sensitive file from the root layout. Apply dark mode
// client-side via a tiny pre-paint script that reads `localStorage` (and
// falls back to the OS-level `prefers-color-scheme: dark`). No FOUC because
// the script runs synchronously before the first paint. The
// `<ThemeSwitcher>` component writes localStorage and toggles the class.
//
// The `darkMode` field still lives in `data/settings/settings.json` as the
// canonical source for the authenticated settings UI; it is no longer
// consulted during SSR, so no part of `settings.json` is reachable from any
// unauthenticated route.
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('orchestra-theme');
    var prefersDark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) document.documentElement.classList.add('dark');
  } catch (_) {}
})();
`.trim();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
