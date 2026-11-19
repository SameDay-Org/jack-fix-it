"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useErrorCopy } from "./error-copy";
import { HtmlLang } from "./html-lang";
import { MascotImage } from "./mascot-image";

// This file runs in the browser: class names are written out (no `cn`, which would ship
// tailwind-merge to every public page).
const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2";
const PRIMARY = `inline-flex h-12 items-center justify-center rounded-pill bg-green-500 px-7 text-base font-bold text-navy-900 transition-colors hover:bg-green-700 hover:text-white ${FOCUS}`;
const SECONDARY = `inline-flex h-12 items-center justify-center rounded-pill border-2 px-7 text-base font-bold transition-colors ${FOCUS}`;

/**
 * What a reader sees when a page could not be made (#462): a calm sentence in the page's
 * language, a retry and the way home. Never the error itself: no message, no digest, no API
 * text (the server logs keep the digest).
 *
 * - `site`: a public page (navy, Jack thinking), in the language of its path.
 * - `panel`: the whole panel, when the staff session could not even be checked (the API is
 *   down or failing): the account is not signed out, the page offers to try again.
 * - `panelPage`: one panel page, inside the panel's frame.
 */
export function ErrorScreen({
  retry,
  variant,
}: {
  retry: () => void;
  variant: "site" | "panel" | "panelPage";
}) {
  const pathname = usePathname() ?? "/";
  const { copy, locale } = useErrorCopy(pathname);

  if (variant === "site") {
    return (
      <main
        lang={locale ?? undefined}
        className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-navy-900 px-5 py-16 text-center text-white"
      >
        {locale ? <HtmlLang locale={locale} /> : null}
        <MascotImage pose="thinking" size={112} className="rounded-full bg-gray-50 p-3" />
        <h1 className="max-w-xl text-[clamp(2rem,3vw+1rem,3rem)] leading-tight font-extrabold tracking-tight text-balance">
          {copy.title}
        </h1>
        <p className="max-w-md text-lg leading-relaxed">{copy.body}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" onClick={retry} className={PRIMARY}>
            {copy.retry}
          </button>
          <Link
            href={copy.homeHref}
            prefetch={false}
            className={`${SECONDARY} border-white/40 text-white hover:border-white`}
          >
            {copy.home}
          </Link>
        </div>
      </main>
    );
  }

  // The whole panel's screen is the page (its main landmark); a page's sits in the panel's main.
  const Frame = variant === "panel" ? "main" : "div";
  return (
    <Frame
      className={
        variant === "panel"
          ? "flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-10"
          : "flex justify-center px-4 py-10"
      }
    >
      <section
        role="alert"
        className="flex w-full max-w-lg flex-col items-start gap-4 rounded-lg bg-white p-8 shadow-[0_8px_24px_rgb(1_23_46/0.08)]"
      >
        <h1 className="text-xl font-bold text-balance">{copy.title}</h1>
        <p className="text-gray-500">{copy.body}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={retry} className={PRIMARY}>
            {copy.retry}
          </button>
          {variant === "panelPage" ? (
            <Link
              href={copy.homeHref}
              prefetch={false}
              className={`${SECONDARY} border-navy-900/15 text-navy-900 hover:border-navy-900`}
            >
              {copy.home}
            </Link>
          ) : null}
        </div>
      </section>
    </Frame>
  );
}
