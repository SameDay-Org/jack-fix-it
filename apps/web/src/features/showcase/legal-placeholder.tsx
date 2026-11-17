import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

import { HtmlLang } from "./html-lang";
import { LanguageToggle } from "./language-toggle";
import { PRIVACY_PATHS, SHOWCASE_PATHS, TERMS_PATHS } from "./routes";
import { CONTAINER, FOCUS_ON_LIGHT, FOCUS_ON_NAVY } from "./ui";
import { Wordmark } from "./wordmark";

const PATHS = { terms: TERMS_PATHS, privacy: PRIVACY_PATHS } as const;

/**
 * Where the footer's Terms and Privacy links lead until the legal texts are approved (#10):
 * a page that says the text is being finalized, in the words the app uses for the same
 * notice. It holds no legal text and is not indexed.
 */
export async function LegalPlaceholder({
  locale,
  document,
}: {
  locale: Locale;
  document: keyof typeof PATHS;
}) {
  const t = await getT(locale);

  return (
    <div lang={locale} className="flex min-h-dvh flex-col bg-gray-50">
      <HtmlLang locale={locale} />
      <header className="bg-navy-900 text-white">
        <div className={cn(CONTAINER, "flex h-16 items-center justify-between gap-4")}>
          <Link
            href={SHOWCASE_PATHS[locale]}
            prefetch={false}
            className={cn("rounded-pill text-xl font-extrabold tracking-tight", FOCUS_ON_NAVY)}
          >
            <Wordmark name={t("brand.name")} />
          </Link>
          <LanguageToggle t={t} locale={locale} paths={PATHS[document]} />
        </div>
      </header>
      <main
        className={cn(CONTAINER, "flex flex-1 flex-col items-start justify-center gap-5 py-16")}
      >
        <h1 className="text-[clamp(2rem,4vw+1rem,3.25rem)] leading-[1.08] font-extrabold tracking-tight [word-spacing:0.1em]">
          {t(`showcase.legal.${document}.title`)}
        </h1>
        <p className="max-w-xl text-xl font-semibold">{t(`showcase.legal.${document}.lead`)}</p>
        <p className="max-w-xl text-lg leading-relaxed text-gray-500">
          {t(`showcase.legal.${document}.body`)}
        </p>
        <Link
          href={SHOWCASE_PATHS[locale]}
          prefetch={false}
          className={cn(
            "mt-2 inline-flex min-h-11 items-center gap-2 rounded-pill font-bold text-green-700 underline-offset-4 hover:underline",
            FOCUS_ON_LIGHT,
          )}
        >
          <ArrowLeft aria-hidden className="size-5" />
          {t("showcase.legal.back")}
        </Link>
      </main>
    </div>
  );
}
