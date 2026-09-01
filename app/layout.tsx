import type { Metadata } from "next";
import AuthGate from "./auth-gate";
import "./globals.css";

export const metadata: Metadata = {
  title: "سشات — أرشفة الصور التاريخية",
  description: "استخراج الصور من الوثائق التاريخية وترقيمها وحفظها.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body><AuthGate>{children}</AuthGate></body></html>;
}
