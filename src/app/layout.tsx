import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-body", subsets: ["latin"] });
const outfit = Outfit({ variable: "--font-display", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Our Family Hub",
  description: "What the house needs, and what's ready.",
};

// The props are typed explicitly rather than with Next's generated
// `LayoutProps` global. That global only exists after a build has written
// .next/types, so depending on it makes `tsc` pass locally (where a build has
// already run) and fail on a clean checkout — which is exactly what happened
// on the first CI run.
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-[family-name:var(--font-body)]">
        {children}
      </body>
    </html>
  );
}
