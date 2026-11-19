import type { MascotPose } from "@jack/mascot";
import type { TFunction } from "i18next";
import {
  BadgeCheck,
  ChevronDown,
  ClipboardList,
  CreditCard,
  FileCheck,
  LifeBuoy,
  type LucideIcon,
  Receipt,
  UserCheck,
} from "lucide-react";
import Link from "next/link";

import { contactEmail } from "@/features/landing/config";
import { LandingFooter } from "@/features/landing/landing-footer";
import { LandingHeader } from "@/features/landing/landing-header";
import { HtmlLang } from "@/features/site/html-lang";
import { MascotImage } from "@/features/site/mascot-image";
import { FOR_PROS_PATHS, SHOWCASE_PATHS } from "@/features/site/routes";
import {
  CONTAINER,
  EYEBROW,
  FOCUS_ON_LIGHT,
  FOCUS_ON_NAVY,
  PRIMARY_ACTION,
  SECONDARY_ACTION_ON_NAVY,
  SECTION_TITLE,
} from "@/features/site/ui";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

/** The page's sections, in order: the header and the hero link to them. */
export const FOR_PROS_ANCHORS = {
  top: "top",
  how: "how",
  why: "why",
  ask: "ask",
  faq: "faq",
} as const;

/** Where "Skip to content" lands. */
const MAIN_ID = "content";

const BADGES = [
  ["leadFees", Receipt],
  ["paid", CreditCard],
  ["records", ClipboardList],
] as const satisfies readonly (readonly [string, LucideIcon])[];

/** The pro's way in, as the app runs it (#88's brief): each step a fact, none a promise. */
const STEPS = [
  ["profile", "wave"],
  ["review", "thinking"],
  ["payouts", "point"],
  ["requests", "peek"],
  ["job", "tools"],
] as const satisfies readonly (readonly [string, MascotPose])[];

const WHY = [
  ["leads", Receipt],
  ["paid", CreditCard],
  ["records", ClipboardList],
  ["support", LifeBuoy],
] as const satisfies readonly (readonly [string, LucideIcon])[];

const ASK = [
  ["documents", FileCheck],
  ["payouts", CreditCard],
  ["profile", UserCheck],
] as const satisfies readonly (readonly [string, LucideIcon])[];

const FAQ = ["fees", "paid", "documents", "choose", "problem", "areas"] as const;

/** The `name` the questions share: the browser keeps one of them open at a time. */
const FAQ_GROUP = "for-pros-faq";

function Heading({
  t,
  id,
  section,
}: {
  t: TFunction;
  id: string;
  section: "how" | "why" | "ask" | "faq";
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className={cn(EYEBROW, "text-green-700")}>{t(`forPros.${section}.eyebrow`)}</p>
      <h2 id={id} className={SECTION_TITLE}>
        {t(`forPros.${section}.title`)}
      </h2>
    </div>
  );
}

function GetApp({ t, locale, label }: { t: TFunction; locale: Locale; label: "hero" | "final" }) {
  return (
    <Link
      href={SHOWCASE_PATHS[locale]}
      prefetch={false}
      className={cn(PRIMARY_ACTION, label === "hero" ? FOCUS_ON_NAVY : FOCUS_ON_LIGHT)}
    >
      {t(`forPros.${label}.getApp`)}
    </Link>
  );
}

function Hero({ t, locale }: { t: TFunction; locale: Locale }) {
  return (
    <section
      id={FOR_PROS_ANCHORS.top}
      aria-labelledby="hero-title"
      className="bg-navy-900 text-white"
    >
      <div
        className={cn(CONTAINER, "grid items-center gap-10 py-14 lg:grid-cols-[1fr_auto] lg:py-24")}
      >
        <div className="flex flex-col items-start gap-6">
          <p className={cn(EYEBROW, "text-green-500")}>{t("forPros.hero.eyebrow")}</p>
          <h1
            id="hero-title"
            className="text-[clamp(2.5rem,5vw+1rem,4.5rem)] leading-[1.02] font-extrabold tracking-tight text-balance"
          >
            {t("forPros.hero.title")}
          </h1>
          <p className="max-w-xl text-lg leading-relaxed">{t("forPros.hero.body")}</p>
          <div className="flex flex-wrap gap-3">
            <GetApp t={t} locale={locale} label="hero" />
            <a href={`#${FOR_PROS_ANCHORS.how}`} className={SECONDARY_ACTION_ON_NAVY}>
              {t("forPros.hero.how")}
            </a>
          </div>
          <ul aria-label={t("forPros.hero.badgesLabel")} className="flex flex-col gap-3">
            {BADGES.map(([id, Icon]) => (
              <li key={id} className="flex items-center gap-2 text-sm font-semibold">
                <Icon aria-hidden className="size-5 shrink-0 text-green-500" />
                {t(`forPros.hero.badges.${id}`)}
              </li>
            ))}
          </ul>
        </div>
        {/* On navy, Jack stands on a light bubble; still, and hidden on a phone, like the landing's. */}
        <div className="mx-auto hidden rounded-full bg-gray-50 p-8 lg:block">
          <MascotImage pose="tools" size={240} />
        </div>
      </div>
    </section>
  );
}

function HowYouGetWork({ t }: { t: TFunction }) {
  return (
    <section id={FOR_PROS_ANCHORS.how} aria-labelledby="how-title" className="py-20">
      <div className={CONTAINER}>
        <Heading t={t} id="how-title" section="how" />
        <ol className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map(([id, pose], index) => (
            <li key={id} className="flex flex-col items-start gap-3">
              <MascotImage pose={pose} size={112} className="rounded-3xl bg-gray-50" />
              <p className={cn(EYEBROW, "text-green-700")}>{index + 1}</p>
              <h3 className="text-xl font-bold">{t(`forPros.how.steps.${id}.title`)}</h3>
              <p className="leading-relaxed text-gray-500">{t(`forPros.how.steps.${id}.body`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function WhyJack({ t }: { t: TFunction }) {
  return (
    <section id={FOR_PROS_ANCHORS.why} aria-labelledby="why-title" className="bg-gray-50 py-20">
      <div className={CONTAINER}>
        <Heading t={t} id="why-title" section="why" />
        <ul className="mt-10 grid gap-4 sm:grid-cols-2">
          {WHY.map(([id, Icon]) => (
            <li key={id} className="flex items-start gap-4 rounded-3xl bg-white p-6">
              <Icon aria-hidden className="size-8 shrink-0 text-green-700" />
              <div className="flex flex-col gap-1">
                <h3 className="text-lg font-bold">{t(`forPros.why.items.${id}.title`)}</h3>
                <p className="text-gray-500">{t(`forPros.why.items.${id}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function WhatWeAsk({ t }: { t: TFunction }) {
  return (
    <section id={FOR_PROS_ANCHORS.ask} aria-labelledby="ask-title" className="py-20">
      <div className={CONTAINER}>
        <Heading t={t} id="ask-title" section="ask" />
        <ul className="mt-10 grid gap-8 sm:grid-cols-3">
          {ASK.map(([id, Icon]) => (
            <li key={id} className="flex items-start gap-4">
              <Icon aria-hidden className="size-7 shrink-0 text-green-700" />
              <p className="text-lg">{t(`forPros.ask.items.${id}`)}</p>
            </li>
          ))}
        </ul>
        <p className="mt-10 inline-flex items-center gap-2 rounded-pill bg-navy-900 px-5 py-2.5 text-base font-semibold text-white">
          <BadgeCheck aria-hidden className="size-5 shrink-0 text-green-500" />
          {t("forPros.ask.note")}
        </p>
      </div>
    </section>
  );
}

/**
 * The questions as native disclosures (`<details>`): each opens with a click, Enter or Space,
 * needs no script, and its answer is in the page for a reader without one.
 */
function Questions({ t }: { t: TFunction }) {
  return (
    <section id={FOR_PROS_ANCHORS.faq} aria-labelledby="faq-title" className="bg-gray-50 py-20">
      <div className={cn(CONTAINER, "grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]")}>
        <Heading t={t} id="faq-title" section="faq" />
        <div className="flex flex-col gap-3">
          {FAQ.map((item) => (
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
                {t(`forPros.faq.items.${item}.question`)}
                <ChevronDown
                  aria-hidden
                  className="size-5 shrink-0 text-green-700 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <p className="px-6 pb-6 leading-relaxed text-gray-500">
                {t(`forPros.faq.items.${item}.answer`)}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCall({ t, locale }: { t: TFunction; locale: Locale }) {
  return (
    <section aria-labelledby="final-title" className="px-3 py-20 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 rounded-xl bg-green-500 px-6 py-16 text-center text-navy-900 lg:rounded-[3rem]">
        <MascotImage pose="celebrate" size={112} className="rounded-full bg-white p-3" />
        <h2 id="final-title" className={cn(SECTION_TITLE, "max-w-3xl")}>
          {t("forPros.final.title")}
        </h2>
        <p className="text-lg font-semibold">{t("forPros.final.body")}</p>
        <Link
          href={SHOWCASE_PATHS[locale]}
          prefetch={false}
          className="inline-flex h-12 items-center justify-center rounded-pill bg-navy-900 px-7 text-base font-bold text-white transition-colors outline-none hover:bg-navy-700 focus-visible:ring-2 focus-visible:ring-navy-900 focus-visible:ring-offset-2 focus-visible:ring-offset-green-500"
        >
          {t("forPros.final.getApp")}
        </Link>
      </div>
    </section>
  );
}

/**
 * The page for professionals (#88, D17.2) in one language: how a pro gets work through Jack
 * Fix It, what we ask of them and their questions, ending on the app (pros sign up there only:
 * no web sign-up or sign-in). Static, rendered on the server, readable without JavaScript. It
 * says only what the product does: no income, volume or rating claims, no price or percentage.
 */
export async function ForProsPage({ locale }: { locale: Locale }) {
  const t = await getT(locale);

  return (
    <div lang={locale}>
      <HtmlLang locale={locale} />
      <a
        href={`#${MAIN_ID}`}
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-white focus:px-5 focus:py-3 focus:font-bold focus:text-navy-900 focus:shadow-xl",
          FOCUS_ON_LIGHT,
        )}
      >
        {t("landing.skipToContent")}
      </a>
      <LandingHeader t={t} locale={locale} page="forPros" />
      <main id={MAIN_ID}>
        <Hero t={t} locale={locale} />
        <HowYouGetWork t={t} />
        <WhyJack t={t} />
        <WhatWeAsk t={t} />
        <Questions t={t} />
        <FinalCall t={t} locale={locale} />
      </main>
      <LandingFooter
        t={t}
        locale={locale}
        contact={contactEmail()}
        year={new Date().getFullYear()}
        paths={FOR_PROS_PATHS}
      />
    </div>
  );
}
