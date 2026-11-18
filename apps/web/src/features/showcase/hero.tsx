import type { TFunction } from "i18next";
import { ArrowDown } from "lucide-react";
import { getImageProps } from "next/image";

import { cn } from "@/lib/utils";

import { accentParts } from "./accent";
import { HeroMotion } from "./hero-motion";
import { HERO_SCREEN_IDS } from "./hero3d/choreography";
import { MascotBubble } from "./mascot-bubble";
import { MEDIA } from "./media";
import { PhoneFrame } from "./phone-frame";
import { ANCHORS } from "./routes";
import { CONTAINER, FOCUS_ON_NAVY, PRIMARY_ACTION } from "@/features/site/ui";

/** How wide the hero's phone is drawn: the `sizes` of its screen images. */
const PHONE_SIZES = "(min-width: 1024px) 360px, (min-width: 640px) 288px, 60vw";

/** A headline beat sits on the others; the one on show fades and rises in. */
const BEAT =
  "col-start-1 row-start-1 transition-[opacity,translate,visibility] duration-500 ease-out still:transition-none";
const BEAT_SHOWN = "visible translate-y-0 opacity-100";
const BEAT_HIDDEN = "invisible translate-y-3 opacity-0";
// Literal class names, one per beat, so that Tailwind finds them.
const BEAT_FIRST_LEAVES =
  "group-data-[beat=1]/hero:invisible group-data-[beat=1]/hero:-translate-y-3 group-data-[beat=1]/hero:opacity-0 group-data-[beat=2]/hero:invisible group-data-[beat=2]/hero:-translate-y-3 group-data-[beat=2]/hero:opacity-0";
const BEAT_ON = {
  1: "group-data-[beat=1]/hero:visible group-data-[beat=1]/hero:translate-y-0 group-data-[beat=1]/hero:opacity-100",
  2: "group-data-[beat=2]/hero:visible group-data-[beat=2]/hero:translate-y-0 group-data-[beat=2]/hero:opacity-100",
} as const;
/** The CSS phone's other screens, each shown while `data-screen` names it. */
const SCREEN_ON = [
  "",
  "group-data-[screen=1]/hero:opacity-100",
  "group-data-[screen=2]/hero:opacity-100",
  "group-data-[screen=3]/hero:opacity-100",
  "group-data-[screen=4]/hero:opacity-100",
] as const;

const BEAT_TITLE =
  "text-[clamp(2.25rem,4vw+1rem,4rem)] leading-[1.05] font-extrabold tracking-tight text-balance [word-spacing:0.1em] short:text-[clamp(1.875rem,3.5vw+1rem,3.25rem)]";

/**
 * The first screen (#403). The hero is pinned while the reader scrolls through a short
 * stretch of it (one and a half screens): the headline changes in three beats (the brand
 * line, then quotes, then paying and following the pro) while the phone shows the app screen
 * of each. The phone is drawn in CSS first; once the page has loaded, a 3D phone replaces it
 * where the device can afford one (hero-motion.tsx, hero3d/).
 *
 * The server renders every beat and screen, so the page reads without any script. When the
 * page keeps still (reduced motion, no script, a viewport too short: the `still` variant),
 * the hero is not pinned: the first beat and the home screen, as a plain section.
 */
export function Hero({ t }: { t: TFunction }) {
  const title = accentParts(t("showcase.hero.title"));
  const later = [
    { beat: 1, key: "quotes", title: accentParts(t("showcase.hero.beats.quotes.title")) },
    { beat: 2, key: "pay", title: accentParts(t("showcase.hero.beats.pay.title")) },
  ] as const;
  const [, ...otherScreens] = HERO_SCREEN_IDS;

  return (
    <section
      id={ANCHORS.top}
      aria-labelledby="hero-title"
      className="relative isolate h-[calc(250svh-4rem)] overflow-clip rounded-b-xl bg-navy-900 text-white lg:rounded-b-[3rem] still:h-auto"
    >
      <HeroMotion
        screens={HERO_SCREEN_IDS.map((id) => MEDIA[id].poster.src)}
        className="group/hero sticky top-16 h-[calc(100svh-4rem)] overflow-x-clip lg:overflow-clip still:relative still:top-0 still:h-auto"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-1/2 -z-10 size-[36rem] -translate-x-1/2 translate-y-1/4 rounded-full bg-radial from-green-500/30 to-transparent to-70% lg:top-1/2 lg:bottom-auto lg:left-[74%] lg:size-[46rem] lg:-translate-y-1/2"
        />
        <div
          className={cn(
            CONTAINER,
            "grid h-full grid-rows-[auto_minmax(0,1fr)] gap-4 pt-6 pb-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:grid-rows-1 lg:items-center lg:gap-10 lg:py-10",
            "still:h-auto still:grid-rows-none still:items-center still:gap-12 still:pt-10 still:pb-0 lg:still:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:still:gap-10 lg:still:py-20",
          )}
        >
          <div className="grid items-start lg:items-center">
            <div
              className={cn(
                BEAT,
                BEAT_SHOWN,
                BEAT_FIRST_LEAVES,
                "flex flex-col items-start gap-4 lg:gap-6 still:gap-6",
              )}
            >
              <p className="inline-flex items-center gap-2.5 rounded-pill bg-navy-700 px-4 py-2 text-sm font-semibold short:hidden still:inline-flex">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-green-500" />
                {t("showcase.hero.soon")}
              </p>
              <h1
                id="hero-title"
                className="text-[clamp(2.25rem,5vw+1rem,4.5rem)] leading-[1.04] font-extrabold tracking-tight text-balance [word-spacing:0.1em] group-data-[beat=1]/hero:visible group-data-[beat=2]/hero:visible short:text-[clamp(1.875rem,4vw+1rem,3.5rem)] still:text-[clamp(2.5rem,6vw+1rem,4.5rem)]"
              >
                {title.before}
                <span className="text-green-500">{title.accent}</span>
                {title.after}
              </h1>
              {/* A short pinned stage drops these lines; a still hero always shows them. */}
              <p className="text-lg font-bold text-green-500 sm:text-2xl short:hidden still:block still:text-xl sm:still:text-2xl">
                {t("showcase.hero.lead")}
              </p>
              <p className="hidden max-w-xl text-lg leading-relaxed sm:block short:hidden still:block">
                {t("showcase.hero.body")}
              </p>
              <a href={`#${ANCHORS.how}`} className={cn(PRIMARY_ACTION, FOCUS_ON_NAVY, "mt-2")}>
                {t("showcase.hero.cta")}
                <ArrowDown aria-hidden className="size-5" />
              </a>
            </div>
            {later.map(({ beat, key, title: line }) => (
              <div
                key={key}
                className={cn(
                  BEAT,
                  BEAT_HIDDEN,
                  BEAT_ON[beat],
                  "flex flex-col gap-4 lg:gap-6 still:hidden",
                )}
              >
                <p className={BEAT_TITLE}>
                  {line.before}
                  <span className="text-green-500">{line.accent}</span>
                  {line.after}
                </p>
                <p className="max-w-xl text-lg leading-relaxed sm:text-xl short:hidden">
                  {t(`showcase.hero.beats.${key}.body`)}
                </p>
              </div>
            ))}
          </div>
          <div className="relative min-h-0 lg:h-full still:h-auto">
            <div className="relative mx-auto flex h-full items-center justify-center still:block still:h-auto">
              <div className="relative aspect-[0.519] h-[74%] max-h-[44rem] short:h-[92%] still:mx-auto still:h-auto still:w-[min(60vw,18rem)] still:-mb-28 sm:still:w-72 lg:still:mb-0 lg:still:w-80">
                <div className="size-full transition-opacity duration-300 motion-reduce:transition-none group-data-[gl=ready]/hero:opacity-0 still:opacity-100!">
                  <PhoneFrame
                    media={MEDIA.home}
                    alt={t(MEDIA.home.alt)}
                    sizes={PHONE_SIZES}
                    eager
                    className="w-full"
                    overlay={otherScreens.map((id, index) => {
                      // No box until the CSS phone animates, so lazy loading leaves them alone
                      // (a browser without scripting loads every image, these included).
                      const { props } = getImageProps({
                        src: MEDIA[id].poster.src,
                        width: MEDIA[id].poster.width,
                        height: MEDIA[id].poster.height,
                        alt: "",
                        sizes: PHONE_SIZES,
                        loading: "lazy",
                      });
                      return (
                        // eslint-disable-next-line @next/next/no-img-element -- next/image's own attributes (getImageProps), as in phone-frame.tsx
                        <img
                          key={id}
                          {...props}
                          alt=""
                          aria-hidden
                          data-hero-screen={id}
                          className={cn(
                            "absolute inset-0 hidden size-full object-cover opacity-0 transition-opacity duration-500 group-data-[mode=css]/hero:block still:hidden!",
                            SCREEN_ON[index + 1],
                          )}
                        />
                      );
                    })}
                  />
                </div>
                {/* It greets with the first headline, then leaves the stage to the phone. */}
                <MascotBubble
                  pose="wave"
                  animate
                  className="absolute z-10 transition-opacity duration-500 group-data-[beat=1]/hero:opacity-0 group-data-[beat=2]/hero:opacity-0 short:hidden still:flex bottom-[12%] -left-[3.5rem] size-16 sm:-left-[5rem] sm:size-20 lg:bottom-[8%] lg:-left-[6.5rem] lg:size-28 still:bottom-40 still:-left-[4.5rem] still:size-20 sm:still:-left-[5.5rem] sm:still:size-24 lg:still:bottom-14 lg:still:-left-[7.5rem] lg:still:size-32"
                />
              </div>
            </div>
            <div
              data-hero-canvas
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 motion-reduce:transition-none group-data-[gl=ready]/hero:opacity-100 still:hidden"
            />
          </div>
        </div>
      </HeroMotion>
    </section>
  );
}
