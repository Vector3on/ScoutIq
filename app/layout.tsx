import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScoutIQ | Payable bug opportunity radar",
  description:
    "A transparent expected-value radar for public bug bounty programs, live attack surfaces, and fresh source code.",
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
