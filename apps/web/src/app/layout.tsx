import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@/client/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "AInote", template: "%s | AInote" },
  description:
    "AIメンバーと進め方を考え、話し合いをノートに残すAInoteのデザインプレビュー。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- This shared App Router layout loads fonts at runtime to keep builds offline. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=IBM+Plex+Sans+JP:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
