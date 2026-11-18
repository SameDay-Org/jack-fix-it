import type { TFunction } from "i18next";
import {
  BadgeCheck,
  CalendarCheck,
  ClipboardList,
  CreditCard,
  Hammer,
  Headset,
  LayoutGrid,
  LifeBuoy,
  type LucideIcon,
  PaintRoller,
  PhoneOff,
  Sparkles,
  Trees,
  Truck,
  Wrench,
} from "lucide-react";
import Link from "next/link";

import { Mascot, type MascotPose } from "@/features/mascot/mascot";
import { HtmlLang } from "@/features/site/html-lang";
import { SHOWCASE_PATHS } from "@/features/site/routes";
import {
  CONTAINER,
  EYEBROW,
  FOCUS_ON_LIGHT,
  FOCUS_ON_NAVY,
  PRIMARY_ACTION,
  SECTION_TITLE,
} from "@/features/site/ui";
import type { Locale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

import {
  isShippedSlug,
  loadCategories,
  type ServiceCategory,
  type ShippedSlug,
} from "./categories";
import { contactEmail, LANDING_ANCHORS, requestFlowEnabled } from "./config";
import { organizationJsonLd } from "./json-ld";
import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";

/** Where "Skip to content" lands. */
const MAIN_ID = "content";

/** Where the request flow (#86) will start: shown only once it ships (`requestFlowEnabled`). */
export const REQUEST_FLOW_ANCHOR = "tell";

const SECONDARY_ACTION = cn(
  "inline-flex h-12 items-center justify-center rounded-pill border-2 border-white/40 px-7 text-base font-bold text-white transition-colors hover:border-white",
  FOCUS_ON_NAVY,
);

const BADGES = [
  ["verified", BadgeCheck],
  ["scheduling", CalendarCheck],
  ["payment", CreditCard],
  ["support", LifeBuoy],
] as const satisfies readonly (readonly [string, LucideIcon])[];

const STEPS = [
  ["tell", "thinking"],
  ["match", "point"],
  ["done", "tools"],
  ["support", "celebrate"],
] as const satisfies readonly (readonly [string, MascotPose])[];

const TRUST = [
  ["whoToCall", PhoneOff],
  ["onePlace", LayoutGrid],
  ["people", Headset],
  ["records", ClipboardList],
] as const satisfies readonly (readonly [string, LucideIcon])[];

/** A flat icon for each shipped category; a category added later gets the wrench. */
const CATEGORY_ICONS: Record<ShippedSlug, LucideIcon> = {
  "house-cleaning": Sparkles,
  handyman: Hammer,
  painting: PaintRoller,
  "lawn-landscaping": Trees,
  "moving-assembly": Truck,
};

function SectionHeading({
  t,
  id,
  section,
}: {
  t: TFunction;
  id: string;
  section: "how" | "services" | "trust";
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className={cn(EYEBROW, "text-green-700")}>{t(`landing.${section}.eyebrow`)}</p>
      <h2 id={id} className={SECTION_TITLE}>
        {t(`landing.${section}.title`)}
      </h2>
    </div>
  );
}

function Hero({ t, locale }: { t: TFunction; locale: Locale }) {
  const flow = requestFlowEnabled();
  return (
    <section
      id={LANDING_ANCHORS.top}
      aria-labelledby="hero-title"
      className="bg-navy-900 text-white"
    >
      <div
        className={cn(CONTAINER, "grid items-center gap-10 py-14 lg:grid-cols-[1fr_auto] lg:py-24")}
      >
        <div className="flex flex-col items-start gap-6">
          <p className={cn(EYEBROW, "text-green-500")}>{t("landing.hero.eyebrow")}</p>
          <h1
            id="hero-title"
            className="text-[clamp(2.5rem,5vw+1rem,4.5rem)] leading-[1.02] font-extrabold tracking-tight text-balance"
          >
            {t("landing.hero.titleLead")}{" "}
            <span className="text-green-500">{t("landing.hero.titleAccent")}</span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed">{t("landing.hero.body")}</p>
          <div className="flex flex-wrap gap-3">
            {flow ? (
              <a href={`#${REQUEST_FLOW_ANCHOR}`} className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY)}>
                {t("landing.requestFlow.cta")}
              </a>
            ) : (
              <Link
                href={SHOWCASE_PATHS[locale]}
                prefetch={false}
                className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY)}
              >
                {t("landing.hero.getApp")}
              </Link>
            )}
            <a href={`#${LANDING_ANCHORS.services}`} className={SECONDARY_ACTION}>
              {t("landing.hero.explore")}
            </a>
          </div>
          <ul aria-label={t("landing.hero.badgesLabel")} className="grid gap-3 sm:grid-cols-2">
            {BADGES.map(([id, Icon]) => (
              <li key={id} className="flex items-center gap-2 text-sm font-semibold">
                <Icon aria-hidden className="size-5 shrink-0 text-green-500" />
                {t(`landing.hero.badges.${id}`)}
              </li>
            ))}
          </ul>
        </div>
        {/* On navy, Jack stands on a light bubble (packages/mascot README). */}
        <div className="mx-auto hidden rounded-full bg-gray-50 p-8 lg:block">
          <Mascot pose="wave" size={240} />
        </div>
      </div>
    </section>
  );
}

/**
 * The seam for the web request flow (#86): one component behind one flag, off by default. Until
 * the flow ships it renders nothing; when it does, its "What's going on at home?" box goes here.
 */
export function RequestEntry({ t }: { t: TFunction }) {
  if (!requestFlowEnabled()) return null;
  return (
    <section id={REQUEST_FLOW_ANCHOR} aria-labelledby="tell-title" className="py-16">
      <div className={CONTAINER}>
        <h2 id="tell-title" className={SECTION_TITLE}>
          {t("landing.requestFlow.title")}
        </h2>
      </div>
    </section>
  );
}

function HowItWorks({ t }: { t: TFunction }) {
  return (
    <section id={LANDING_ANCHORS.how} aria-labelledby="how-title" className="py-20">
      <div className={CONTAINER}>
        <SectionHeading t={t} id="how-title" section="how" />
        <ol className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([id, pose], index) => (
            <li key={id} className="flex flex-col items-start gap-3">
              <Mascot pose={pose} size={112} className="rounded-3xl bg-gray-50" />
              <p className={cn(EYEBROW, "text-green-700")}>{index + 1}</p>
              <h3 className="text-xl font-bold">{t(`landing.how.steps.${id}.title`)}</h3>
              <p className="leading-relaxed text-gray-500">{t(`landing.how.steps.${id}.body`)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Services({ t, categories }: { t: TFunction; categories: ServiceCategory[] }) {
  return (
    <section
      id={LANDING_ANCHORS.services}
      aria-labelledby="services-title"
      className="bg-gray-50 py-20"
    >
      <div className={CONTAINER}>
        <SectionHeading t={t} id="services-title" section="services" />
        <p className="mt-4 max-w-2xl text-lg text-gray-500">{t("landing.services.body")}</p>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map(({ slug, name }) => {
            // A category the product ships has its own line; one added later, the general one.
            const shipped = isShippedSlug(slug) ? slug : null;
            const Icon = shipped ? CATEGORY_ICONS[shipped] : Wrench;
            return (
              <li key={slug} className="flex items-start gap-4 rounded-3xl bg-white p-6">
                <Icon aria-hidden className="size-8 shrink-0 text-green-700" />
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-bold">
                    {name ?? (shipped ? t(`landing.services.names.${shipped}`) : slug)}
                  </h3>
                  <p className="text-gray-500">
                    {shipped ? t(`landing.services.lines.${shipped}`) : t("landing.services.other")}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Trust({ t }: { t: TFunction }) {
  return (
    <section aria-labelledby="trust-title" className="py-20">
      <div className={CONTAINER}>
        <SectionHeading t={t} id="trust-title" section="trust" />
        <ul className="mt-10 grid gap-8 sm:grid-cols-2">
          {TRUST.map(([id, Icon]) => (
            <li key={id} className="flex items-start gap-4">
              <Icon aria-hidden className="size-7 shrink-0 text-green-700" />
              <div className="flex flex-col gap-1">
                <h3 className="text-lg font-bold">{t(`landing.trust.items.${id}.title`)}</h3>
                <p className="text-gray-500">{t(`landing.trust.items.${id}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ForPros({ t, locale }: { t: TFunction; locale: Locale }) {
  return (
    <section
      id={LANDING_ANCHORS.pros}
      aria-labelledby="pros-title"
      className="bg-navy-700 py-20 text-white"
    >
      <div className={cn(CONTAINER, "flex flex-col items-start gap-6")}>
        <p className={cn(EYEBROW, "text-green-500")}>{t("landing.pros.eyebrow")}</p>
        <h2 id="pros-title" className={SECTION_TITLE}>
          {t("landing.pros.title")}
        </h2>
        <p className="max-w-2xl text-lg leading-relaxed">{t("landing.pros.body")}</p>
        <ul className="flex flex-col gap-2 text-lg font-semibold">
          <li>{t("landing.pros.points.leads")}</li>
          <li>{t("landing.pros.points.paid")}</li>
        </ul>
        <Link
          href={`${SHOWCASE_PATHS[locale]}#pros`}
          prefetch={false}
          className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY)}
        >
          {t("landing.pros.link")}
        </Link>
      </div>
    </section>
  );
}

/**
 * The public landing page (#85, D17.1) in one language: it sells the service and sends a
 * customer to the app (the request flow on the web is #86). Rendered on the server, readable
 * without JavaScript. It claims only what the product does (root AGENTS.md, the plan's text
 * rules): no reviews, ratings or counts, no prices, no promise the legal texts have not approved.
 */
export async function LandingPage({ locale }: { locale: Locale }) {
  const t = await getT(locale);
  const categories = await loadCategories(locale);
  const organization = organizationJsonLd(t("brand.name"));

  return (
    <div lang={locale}>
      <HtmlLang locale={locale} />
      {organization ? (
        // The text is our own JSON, with `<` escaped (json-ld.ts): it cannot close the script.
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: organization }} />
      ) : null}
      <a
        href={`#${MAIN_ID}`}
        className={cn(
          "sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-white focus:px-5 focus:py-3 focus:font-bold focus:text-navy-900 focus:shadow-xl",
          FOCUS_ON_LIGHT,
        )}
      >
        {t("landing.skipToContent")}
      </a>
      <LandingHeader t={t} locale={locale} />
      <main id={MAIN_ID}>
        <Hero t={t} locale={locale} />
        <RequestEntry t={t} />
        <HowItWorks t={t} />
        <Services t={t} categories={categories} />
        <Trust t={t} />
        <ForPros t={t} locale={locale} />
      </main>
      <LandingFooter
        t={t}
        locale={locale}
        contact={contactEmail()}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
