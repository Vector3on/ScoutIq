import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScopePulse | Fresh bug bounty signals",
  description:
    "A transparent, source-first radar for newly launched and newly expanded public bug bounty programs.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
