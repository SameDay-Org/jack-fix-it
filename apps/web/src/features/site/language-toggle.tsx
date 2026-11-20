import type { TFunction } from "i18next";
import Link from "next/link";

import { type Locale, locales } from "@/i18n/config";
import { cn } from "@/lib/utils";

import { FOCUS_ON_NAVY } from "./ui";

type LanguageToggleProps = {
  t: TFunction;
  /** The language the page is in. */
  locale: Locale;
  /** The address of this same page in each language. */
  paths: Record<Locale, string>;
  /** The landmark's name when the page has a second switch (the footer's): names must differ. */
  label?: string;
  className?: string;
};

/**
 * The language switch of the header and the footer (both navy): one link per language to the
 * same page in it, the current one marked. Plain links, so it works without JavaScript and a
 * crawler can follow it. Each shows its code and carries the language's own name for a screen
 * reader, in that language.
 */
export function LanguageToggle({ t, locale, paths, label, className }: LanguageToggleProps) {
  return (
    <nav
      aria-label={label ?? t("site.language.label")}
      className={cn("inline-flex shrink-0 rounded-pill bg-navy-700 p-1", className)}
    >
      {locales.map((value) => (
        <Link
          key={value}
          href={paths[value]}
          hrefLang={value}
          lang={value}
          prefetch={false}
          aria-current={value === locale ? "page" : undefined}
          className={cn(
            "inline-flex h-9 min-w-11 items-center justify-center rounded-pill px-3 text-sm font-bold transition-colors",
            FOCUS_ON_NAVY,
            value === locale ? "bg-white text-navy-900" : "text-white hover:bg-navy-900",
          )}
        >
          {value.toUpperCase()}
          <span className="sr-only"> {t(`site.language.${value}`)}</span>
        </Link>
      ))}
    </nav>
  );
}
