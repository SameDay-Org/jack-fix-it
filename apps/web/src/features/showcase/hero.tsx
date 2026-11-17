import type { TFunction } from "i18next";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";

import { accentParts } from "./accent";
import { MascotBubble } from "./mascot-bubble";
import { MEDIA } from "./media";
import { PhoneFrame } from "./phone-frame";
import { ANCHORS } from "./routes";
import { CONTAINER, FOCUS_ON_NAVY, PRIMARY_ACTION } from "./ui";

/**
 * The first screen: the brand's line with its key word in lime, what the app does in two
 * sentences, the way down to "how it works", and the app's home screen in a phone. The store
 * notice says "coming soon": the app is not in the stores yet, so there is no download
 * button. On a small screen the phone is cut by the hero's lower edge.
 */
export function Hero({ t }: { t: TFunction }) {
  const title = accentParts(t("showcase.hero.title"));

  return (
    <section
      id={ANCHORS.top}
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden rounded-b-xl bg-navy-900 text-white lg:rounded-b-[3rem]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-1/2 -z-10 size-[36rem] -translate-x-1/2 translate-y-1/4 rounded-full bg-radial from-green-500/30 to-transparent to-70% lg:top-1/2 lg:bottom-auto lg:left-[74%] lg:size-[46rem] lg:-translate-y-1/2"
      />
      <div
        className={cn(
          CONTAINER,
          "grid items-center gap-12 pt-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-10 lg:py-20",
        )}
      >
        <div className="flex flex-col items-start gap-6">
          <p className="inline-flex items-center gap-2.5 rounded-pill bg-navy-700 px-4 py-2 text-sm font-semibold">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-green-500" />
            {t("showcase.hero.soon")}
          </p>
          <h1
            id="hero-title"
            className="text-[clamp(2.5rem,6vw+1rem,4.5rem)] leading-[1.04] font-extrabold tracking-tight text-balance [word-spacing:0.1em]"
          >
            {title.before}
            <span className="text-green-500">{title.accent}</span>
            {title.after}
          </h1>
          <p className="text-xl font-bold text-green-500 sm:text-2xl">{t("showcase.hero.lead")}</p>
          <p className="max-w-xl text-lg leading-relaxed">{t("showcase.hero.body")}</p>
          <a href={`#${ANCHORS.how}`} className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY, "mt-2")}>
            {t("showcase.hero.cta")}
            <ArrowDown aria-hidden className="size-5" />
          </a>
        </div>
        <div className="relative mx-auto -mb-28 w-[min(60vw,18rem)] sm:w-72 lg:mb-0 lg:w-80">
          <PhoneFrame
            media={MEDIA.home}
            alt={t(MEDIA.home.alt)}
            sizes="(min-width: 1024px) 320px, (min-width: 640px) 288px, 60vw"
            eager
          />
          <MascotBubble
            pose="wave"
            className="absolute bottom-40 -left-[4.5rem] size-20 sm:-left-[5.5rem] sm:size-24 lg:bottom-14 lg:-left-[7.5rem] lg:size-32"
          />
        </div>
      </div>
    </section>
  );
}
