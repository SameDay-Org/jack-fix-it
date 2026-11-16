import type { TFunction } from "i18next";

import type { MascotPose } from "@/features/mascot/mascot";
import { cn } from "@/lib/utils";

import { MascotBubble } from "./mascot-bubble";
import { MEDIA, type MediaId } from "./media";
import { PhoneFrame } from "./phone-frame";
import { ANCHORS } from "./routes";
import { ANCHOR_OFFSET, CONTAINER, EYEBROW, SECTION_TITLE } from "./ui";

type Feature<Id extends MediaId = MediaId> = {
  /** Its strings (`showcase.features.<id>`) and its screen in the media manifest. */
  id: Id;
  /** Which Jack stands beside it. */
  pose: MascotPose;
};

/** What a customer does, in the order it happens: one section each. */
export const CUSTOMER_FEATURES = [
  { id: "describe", pose: "tools" },
  { id: "quotes", pose: "thinking" },
  { id: "pay", pose: "point" },
  { id: "track", pose: "peek" },
  { id: "chat", pose: "wave" },
  { id: "reviews", pose: "celebrate" },
] as const satisfies readonly Feature<Exclude<MediaId, "home" | "pros">>[];

/** The pros' side of the app: its own band, after the customer's steps. */
export const PRO_FEATURE = { id: "pros", pose: "tools" } as const satisfies Feature<"pros">;

/** How wide a section's phone is drawn: the `sizes` of its screen image. */
const PHONE_SIZES = "(min-width: 640px) 280px, 60vw";
const PHONE_WIDTH = "w-[min(60vw,17.5rem)] sm:w-[17.5rem]";

/**
 * "How it works": the customer's six steps as an ordered list, each a short headline and one
 * line of text beside a real screen of the app. Text and phone swap sides from one step to
 * the next on a wide screen; on a small one the text always comes first.
 */
export function HowItWorks({ t }: { t: TFunction }) {
  return (
    <section
      id={ANCHORS.how}
      aria-labelledby="how-title"
      className={cn(ANCHOR_OFFSET, "py-20 lg:py-28")}
    >
      <div className={CONTAINER}>
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
          <p className={cn(EYEBROW, "text-green-700")}>{t("showcase.how.eyebrow")}</p>
          <h2 id="how-title" className={SECTION_TITLE}>
            {t("showcase.how.title")}
          </h2>
          <p className="text-lg leading-relaxed text-gray-500">{t("showcase.how.body")}</p>
        </div>
        <ol className="mt-16 flex flex-col gap-24 lg:mt-24 lg:gap-28">
          {CUSTOMER_FEATURES.map((feature, index) => {
            const media = MEDIA[feature.id];
            const flipped = index % 2 === 1;
            return (
              <li key={feature.id} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-20">
                <div className={cn("flex flex-col items-start gap-5", flipped && "lg:order-2")}>
                  <p className={cn(EYEBROW, "flex items-center gap-3 text-green-700")}>
                    <span
                      aria-hidden
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-green-500 text-base font-extrabold tracking-normal text-navy-900"
                    >
                      {index + 1}
                    </span>
                    {t(`showcase.features.${feature.id}.label`)}
                  </p>
                  <h3 className="text-[clamp(1.875rem,3vw+1rem,2.75rem)] leading-[1.1] font-extrabold tracking-tight text-balance [word-spacing:0.1em]">
                    {t(`showcase.features.${feature.id}.title`)}
                  </h3>
                  <p className="max-w-md text-lg leading-relaxed text-gray-500">
                    {t(`showcase.features.${feature.id}.body`)}
                  </p>
                </div>
                <div
                  className={cn(
                    "relative isolate flex justify-center rounded-xl bg-gray-50 px-6 py-10 lg:py-14",
                    flipped && "lg:order-1",
                  )}
                >
                  <span
                    aria-hidden
                    className="absolute top-1/2 left-1/2 -z-10 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-green-500/15 lg:size-80"
                  />
                  <PhoneFrame
                    media={media}
                    alt={t(media.alt)}
                    sizes={PHONE_SIZES}
                    className={PHONE_WIDTH}
                  />
                  <MascotBubble
                    pose={feature.pose}
                    className={cn(
                      "absolute -bottom-7 size-24 lg:size-28",
                      flipped ? "right-4 lg:-right-8" : "left-4 lg:-left-8",
                    )}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/** The pros' side of the app, on navy: new requests, one fixed price, paid on confirmation. */
export function ForPros({ t }: { t: TFunction }) {
  const media = MEDIA[PRO_FEATURE.id];

  return (
    <section
      id={ANCHORS.pros}
      aria-labelledby="pros-title"
      className={cn(ANCHOR_OFFSET, "px-3 sm:px-6")}
    >
      <div className="mx-auto max-w-7xl rounded-xl bg-navy-900 text-white lg:rounded-[3rem]">
        <div
          className={cn(
            CONTAINER,
            "grid items-center gap-10 py-16 lg:grid-cols-2 lg:gap-20 lg:py-24",
          )}
        >
          <div className="flex flex-col items-start gap-5">
            <p className={cn(EYEBROW, "text-green-500")}>{t("showcase.features.pros.label")}</p>
            <h2 id="pros-title" className={SECTION_TITLE}>
              {t("showcase.features.pros.title")}
            </h2>
            <p className="max-w-md text-lg leading-relaxed">{t("showcase.features.pros.body")}</p>
          </div>
          <div className="relative isolate flex justify-center rounded-xl bg-navy-700 px-6 py-10 lg:py-14">
            <span
              aria-hidden
              className="absolute top-1/2 left-1/2 -z-10 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-green-500/20 lg:size-80"
            />
            <PhoneFrame
              media={media}
              alt={t(media.alt)}
              sizes={PHONE_SIZES}
              className={PHONE_WIDTH}
            />
            <MascotBubble
              pose={PRO_FEATURE.pose}
              className="absolute right-4 -bottom-7 size-24 lg:-right-8 lg:size-28"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
