import type { Metadata } from "next";
import type { ReactNode } from "react";

import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT(defaultLocale);
  return { title: t("brand.name"), description: t("brand.tagline") };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={defaultLocale}>
      <body className="bg-white text-navy antialiased">{children}</body>
    </html>
  );
}
