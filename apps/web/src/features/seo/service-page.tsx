import type { TFunction } from "i18next";
import {
  BadgeCheck,
  CalendarCheck,
  CreditCard,
  LifeBuoy,
  type LucideIcon,
  MapPin,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { contactEmail } from "@/features/landing/config";
import { LandingFooter } from "@/features/landing/landing-footer";
import { LandingHeader } from "@/features/landing/landing-header";
import { HowItWorks } from "@/features/landing/landing-page";
import { HtmlLang } from "@/features/site/html-lang";
import { MascotImage } from "@/features/site/mascot-image";
import { SHOWCASE_PATHS } from "@/features/site/routes";
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

import {
  type Category,
  findService,
  type IntakeQuestion,
  loadCatalog,
  localized,
  type Region,
  serviceCategories,
  servedPlace,
  servedRegions,
  servicePaths,
} from "./catalog";
import { serviceLine } from "./copy";

/** The page's sections, in order: the header and the hero link to them. */
export const SERVICE_ANCHORS = { top: "top", ask: "ask", how: "how", areas: "areas" } as const;

/** Where "Skip to content" lands. */
const MAIN_ID = "content";

/** The landing's approved lines (docs/mvp-plan.md, "Regras de texto"), under the hero. */
const BADGES = [
  ["verified", BadgeCheck],
  ["scheduling", CalendarCheck],
  ["payment", CreditCard],
  ["support", LifeBuoy],
] as const satisfies readonly (readonly [string, LucideIcon])[];

function Heading({ t, id, section }: { t: TFunction; id: string; section: "ask" | "areas" }) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className={cn(EYEBROW, "text-green-700")}>{t(`seo.service.${section}.eyebrow`)}</p>
      <h2 id={id} className={SECTION_TITLE}>
        {t(`seo.service.${section}.title`)}
      </h2>
    </div>
  );
}

function Hero({
  t,
  locale,
  title,
  line,
}: {
  t: TFunction;
  locale: Locale;
  title: string;
  line: string;
}) {
  return (
    <section
      id={SERVICE_ANCHORS.top}
      aria-labelledby="hero-title"
      className="bg-navy-900 text-white"
    >
      <div
        className={cn(CONTAINER, "grid items-center gap-10 py-14 lg:grid-cols-[1fr_auto] lg:py-24")}
      >
        <div className="flex flex-col items-start gap-6">
          <p className={cn(EYEBROW, "text-green-500")}>{t("seo.service.hero.eyebrow")}</p>
          <h1
            id="hero-title"
            className="text-[clamp(2.5rem,5vw+1rem,4.5rem)] leading-[1.02] font-extrabold tracking-tight text-balance"
          >
            {title}
          </h1>
          <p className="max-w-xl text-xl font-semibold text-green-500">{line}</p>
          <p className="max-w-xl text-lg leading-relaxed">{t("seo.service.hero.body")}</p>
          <div className="flex flex-wrap gap-3">
            <Link
              href={SHOWCASE_PATHS[locale]}
              prefetch={false}
              className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY)}
            >
              {t("seo.service.hero.getApp")}
            </Link>
            <a href={`#${SERVICE_ANCHORS.ask}`} className={SECONDARY_ACTION_ON_NAVY}>
              {t("seo.service.hero.ask")}
            </a>
          </div>
          <ul aria-label={t("landing.hero.badgesLabel")} className="flex flex-col gap-3">
            {BADGES.map(([id, Icon]) => (
              <li key={id} className="flex items-center gap-2 text-sm font-semibold">
                <Icon aria-hidden className="size-5 shrink-0 text-green-500" />
                {t(`landing.hero.badges.${id}`)}
              </li>
            ))}
          </ul>
        </div>
        {/* On navy, Jack stands on a light bubble; still, and hidden on a phone, like the landing's. */}
        <div className="mx-auto hidden rounded-full bg-gray-50 p-8 lg:block">
          <MascotImage pose="point" size={240} />
        </div>
      </div>
    </section>
  );
}

/** A question as the app asks it, with its choices when it has some (the API's own text). */
function Question({ question, locale }: { question: IntakeQuestion; locale: Locale }) {
  const options = "options" in question ? question.options : [];
  return (
    <li className="flex flex-col gap-4 rounded-3xl bg-white p-6">
      <h3 className="text-lg font-bold">{localized(question.labels, locale, question.key)}</h3>
      {options.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {options.map((option) => {
            const description = localized(option.description, locale, "");
            return (
              <li
                key={option.value}
                className="flex flex-col gap-0.5 rounded-md bg-gray-50 px-4 py-3"
              >
                <span className="font-semibold">
                  {localized(option.labels, locale, option.value)}
                </span>
                {description ? <span className="text-sm text-gray-500">{description}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function WhatJackAsks({
  t,
  locale,
  category,
}: {
  t: TFunction;
  locale: Locale;
  category: Category;
}) {
  const questions = category.intake_questions;
  return (
    <section id={SERVICE_ANCHORS.ask} aria-labelledby="ask-title" className="bg-gray-50 py-20">
      <div className={CONTAINER}>
        <Heading t={t} id="ask-title" section="ask" />
        <p className="mt-4 max-w-2xl text-lg text-gray-500">
          {questions.length > 0 ? t("seo.service.ask.body") : t("seo.service.ask.none")}
        </p>
        {questions.length > 0 ? (
          <ol className="mt-10 grid gap-4 lg:grid-cols-2">
            {questions.map((question) => (
              <Question key={question.key} question={question} locale={locale} />
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

/** The served cities, as the API lists them; a region's name only when there are several. */
function WhereJackWorks({ t, regions }: { t: TFunction; regions: Region[] }) {
  return (
    <section id={SERVICE_ANCHORS.areas} aria-labelledby="areas-title" className="bg-gray-50 py-20">
      <div className={CONTAINER}>
        <Heading t={t} id="areas-title" section="areas" />
        <p className="mt-4 max-w-2xl text-lg text-gray-500">{t("seo.service.areas.body")}</p>
        <div className="mt-10 flex flex-col gap-8">
          {regions.map((region) => (
            <div key={region.region} className="flex flex-col gap-4">
              {regions.length > 1 ? <h3 className="text-xl font-bold">{region.region}</h3> : null}
              <ul className="flex flex-wrap gap-2">
                {region.cities.map((city) => (
                  <li
                    key={`${city.city}-${city.state}`}
                    className="inline-flex items-center gap-2 rounded-pill bg-white px-4 py-2 font-semibold"
                  >
                    <MapPin aria-hidden className="size-4 shrink-0 text-green-700" />
                    {`${city.city}, ${city.state}`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The other services' pages: the reader's next step when this is not the job. */
function MoreServices({ t, locale, others }: { t: TFunction; locale: Locale; others: Category[] }) {
  if (others.length === 0) return null;
  return (
    <nav aria-labelledby="more-title" className="py-20">
      <div className={CONTAINER}>
        <h2 id="more-title" className="text-2xl font-extrabold tracking-tight">
          {t("seo.service.more.title")}
        </h2>
        <ul className="mt-6 flex flex-wrap gap-3">
          {others.map((other) => (
            <li key={other.slug}>
              <Link
                href={servicePaths(other.slug)[locale]}
                prefetch={false}
                className={cn(
                  "inline-flex h-11 items-center rounded-pill border-2 border-navy-900/15 px-5 font-semibold transition-colors hover:border-navy-900",
                  FOCUS_ON_LIGHT,
                )}
              >
                {localized(other.names, locale, other.slug)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function FinalCall({ t, locale }: { t: TFunction; locale: Locale }) {
  return (
    <section aria-labelledby="final-title" className="px-3 pb-20 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 rounded-xl bg-green-500 px-6 py-16 text-center text-navy-900 lg:rounded-[3rem]">
        <MascotImage pose="celebrate" size={112} className="rounded-full bg-white p-3" />
        <h2 id="final-title" className={cn(SECTION_TITLE, "max-w-3xl")}>
          {t("seo.service.final.title")}
        </h2>
        <p className="text-lg font-semibold">{t("seo.service.final.body")}</p>
        <Link
          href={SHOWCASE_PATHS[locale]}
          prefetch={false}
          className="inline-flex h-12 items-center justify-center rounded-pill bg-navy-900 px-7 text-base font-bold text-white transition-colors outline-none hover:bg-navy-700 focus-visible:ring-2 focus-visible:ring-navy-900 focus-visible:ring-offset-2 focus-visible:ring-offset-green-500"
        >
          {t("seo.service.final.getApp")}
        </Link>
      </div>
    </section>
  );
}

/** The page's headline: the service, and the region when Jack serves exactly one. */
export function serviceTitle(t: TFunction, name: string, place: string | null): string {
  return place
    ? t("seo.service.hero.title", { name, place })
    : t("seo.service.hero.titleAnywhere", { name });
}

/**
 * A service's page (#87, D17.3) in one language, at `/<slug>` and `/es/<slug>`: what the
 * service is, what the app asks about the job, how it works and where Jack works, ending on the
 * app (the web request flow, #86, takes its place once it ships). Everything on it is the API's
 * catalog or approved copy: no price, no count of pros or jobs, no reviews or ratings, no
 * promise the legal texts have not approved. An inactive, unserved or unknown slug is a 404;
 * an unreachable API throws (catalog.ts), it never yields an empty page.
 */
export async function ServicePage({ locale, slug }: { locale: Locale; slug: string }) {
  const catalog = await loadCatalog();
  const category = findService(catalog, slug);
  if (!category) notFound();
  const t = await getT(locale);
  const name = localized(category.names, locale, category.slug);
  const others = serviceCategories(catalog).filter((other) => other.slug !== category.slug);

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
      <LandingHeader t={t} locale={locale} page="service" />
      <main id={MAIN_ID}>
        <Hero
          t={t}
          locale={locale}
          title={serviceTitle(t, name, servedPlace(catalog))}
          line={serviceLine(t, category.slug)}
        />
        <WhatJackAsks t={t} locale={locale} category={category} />
        <HowItWorks t={t} />
        <WhereJackWorks t={t} regions={servedRegions(catalog)} />
        <MoreServices t={t} locale={locale} others={others} />
        <FinalCall t={t} locale={locale} />
      </main>
      <LandingFooter
        t={t}
        locale={locale}
        contact={contactEmail()}
        year={new Date().getFullYear()}
        paths={servicePaths(category.slug)}
      />
    </div>
  );
}
