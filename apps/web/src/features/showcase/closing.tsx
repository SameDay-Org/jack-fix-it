import type { TFunction } from "i18next";
import { ChevronDown, Smartphone } from "lucide-react";

import { cn } from "@/lib/utils";

import { MascotBubble } from "./mascot-bubble";
import { ANCHORS } from "./routes";
import { ANCHOR_OFFSET, CONTAINER, EYEBROW, FOCUS_ON_LIGHT, SECTION_TITLE } from "./ui";

/** The platforms the app is coming to, in the order the notice names them. */
const PLATFORMS = ["ios", "android"] as const;

/**
 * The store notice. The app is not in the stores yet, so this is a notice and not a button:
 * no store badge, no link, nothing that looks like a download.
 */
export function ComingSoon({ t }: { t: TFunction }) {
  return (
    <section
      id={ANCHORS.soon}
      aria-labelledby="soon-title"
      className={cn(ANCHOR_OFFSET, "py-20 lg:py-28")}
    >
      <div className={cn(CONTAINER, "flex flex-col items-center gap-6 text-center")}>
        <h2 id="soon-title" className={cn(SECTION_TITLE, "max-w-3xl")}>
          {t("showcase.soon.title")}
        </h2>
        <p className="max-w-xl text-lg leading-relaxed text-gray-500">{t("showcase.soon.body")}</p>
        <ul className="mt-2 flex flex-wrap justify-center gap-4">
          {PLATFORMS.map((platform) => (
            <li
              key={platform}
              className="flex items-center gap-4 rounded-lg bg-white py-4 pr-7 pl-4 text-left shadow-xl shadow-navy-900/10"
            >
              <span
                aria-hidden
                className="grid size-12 place-items-center rounded-md bg-navy-900 text-green-500"
              >
                <Smartphone className="size-6" />
              </span>
              <span className="flex flex-col">
                <span className="text-lg font-extrabold">{t(`showcase.soon.${platform}`)}</span>
                <span className="text-sm font-semibold text-gray-500">
                  {t("showcase.soon.badge")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The questions, in the order they are shown. Each has a question and an answer string. */
export const FAQ_ITEMS = [
  "what",
  "cost",
  "paid",
  "methods",
  "verified",
  "privacy",
  "languages",
  "available",
  "joinPro",
] as const;

/** The `name` the questions share: the browser keeps one of them open at a time. */
const FAQ_GROUP = "showcase-faq";

/**
 * The questions as native disclosures (`<details>`): each opens with a click, Enter or Space,
 * needs no script, and its answer is in the page for a reader without one. The answers reuse
 * the app's own help texts, so the page promises what the app does and nothing more.
 */
export function Faq({ t }: { t: TFunction }) {
  return (
    <section
      id={ANCHORS.faq}
      aria-labelledby="faq-title"
      className={cn(ANCHOR_OFFSET, "bg-gray-50 py-20 lg:py-28")}
    >
      <div
        className={cn(
          CONTAINER,
          "grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20",
        )}
      >
        <div className="flex flex-col items-start gap-4">
          <p className={cn(EYEBROW, "text-green-700")}>{t("showcase.faq.eyebrow")}</p>
          <h2 id="faq-title" className={SECTION_TITLE}>
            {t("showcase.faq.title")}
          </h2>
          <MascotBubble pose="thinking" className="mt-4 hidden size-32 lg:flex" />
        </div>
        <div className="flex flex-col gap-3">
          {FAQ_ITEMS.map((item) => (
            <details
              key={item}
              name={FAQ_GROUP}
              className="group rounded-lg bg-white shadow-lg shadow-navy-900/5"
            >
              <summary
                className={cn(
                  "flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg px-6 py-5 text-lg font-bold [&::-webkit-details-marker]:hidden",
                  FOCUS_ON_LIGHT,
                )}
              >
                {t(`showcase.faq.items.${item}.question`)}
                <ChevronDown
                  aria-hidden
                  className="size-5 shrink-0 text-green-700 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <p className="px-6 pb-6 leading-relaxed text-gray-500">
                {t(`showcase.faq.items.${item}.answer`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The last word: the brand's promise and, again, that the app is on its way. */
export function FinalCall({ t }: { t: TFunction }) {
  return (
    <section aria-labelledby="final-title" className="px-3 py-20 sm:px-6 lg:py-28">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 rounded-xl bg-green-500 px-6 py-16 text-center text-navy-900 lg:rounded-[3rem] lg:py-24">
        <MascotBubble pose="celebrate" className="size-28" />
        <h2 id="final-title" className={cn(SECTION_TITLE, "max-w-3xl")}>
          {t("showcase.final.title")}
        </h2>
        <p className="inline-flex items-center gap-2.5 rounded-pill bg-navy-900 px-5 py-2.5 text-base font-semibold text-white">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-green-500" />
          {t("showcase.final.body")}
        </p>
      </div>
    </section>
  );
}
