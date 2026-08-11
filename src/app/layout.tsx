import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

// `variable` must stay applied via className below even though nothing references
// `var(--font-plus-jakarta)` in CSS — it's what keeps Next.js from tree-shaking the
// @font-face injection. globals.css hardcodes the literal "Plus Jakarta Sans" family
// name instead (matching the font Next.js actually emits), same pattern as this
// scaffold's original Geist setup.
const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "fn-calendar",
  description: "Find a time and send real calendar invites — FounderNexus expert sessions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plusJakarta.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-6">{children}</main>
      </body>
    </html>
  );
}
