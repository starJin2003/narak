import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NARAK | Creative context review",
  description: "Review advertisement copy, imagery, and timing in South Korean cultural context, with an inspectable evidence trail.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
