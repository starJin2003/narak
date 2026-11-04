import type { Metadata, Viewport } from "next";
import { Mona_Sans } from "next/font/google";
import "./globals.css";

// Mona Sans is licensed under the SIL Open Font License 1.1. The width axis gives
// headings their wider cut without loading a second family.
const mona = Mona_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mona", display: "swap" });

export const metadata: Metadata = {
  title: "NARAK | Poster review",
  description: "Review a poster, its copy and the date it runs in South Korean cultural context, with an evidence trail you can inspect.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#06070F", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={mona.variable}><body>{children}</body></html>;
}
