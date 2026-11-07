import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { GlassSurface, useFlag } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";
import { pressedTransform, tokens, withOpacity } from "@/theme";

import { jobHref } from "./api";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { bannerParts, bannerText, type ActiveJob } from "./phase";

const CHEVRON = 20;
const DOT = 10;
const RIPPLE_OPACITY = 0.15;
const RIPPLE = { color: withOpacity("white", RIPPLE_OPACITY) };

export type JobBannerProps = {
  active: ActiveJob;
  /** When the job was last answered (`useActiveJob`). */
  updatedAt: number;
};

/**
 * The tabs' one line about the job under way ("Dan is on the way · 12 min"; when it does not fit,
 * the sentence is cut short, never the time it ends with), floating over the
 * tab bar as its accessory: a dark pill on the controls layer (Liquid Glass where the device
 * draws it) with a green dot, the line and a chevron. A tap opens the ongoing job screen. It
 * never carries the arrival code.
 */
export function JobBanner({ active, updatedAt }: JobBannerProps) {
  const { t } = useTranslation();
  const { job } = active;
  const now = useMinuteClock(updatedAt, job.eta_at === null ? null : Date.parse(job.eta_at));
  const [pressed, pressIn, pressOut] = useFlag();
  const push = useGuardedPush();
  const text = bannerText(t, job, now, jobsConfig.etaCloseMinutes);
  const parts = bannerParts(t, job, now, jobsConfig.etaCloseMinutes);
  if (text === null || parts === null) return null;

  return (
    <GlassSurface tone="dark" shape="pill" interactive className="flex-1 overflow-hidden">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint={t("jobs.banner.hint")}
        onPress={() => push(jobHref(active.requestId))}
        onPressIn={pressIn}
        onPressOut={pressOut}
        android_ripple={RIPPLE}
        // A style, not a `scale-*` class: a transform class that appears on press remounts the view.
        style={pressed ? pressedTransform : undefined}
        className="flex-1 flex-row items-center gap-3 px-5"
        testID="job-banner"
      >
        <View className="rounded-pill bg-green-500" style={{ width: DOT, height: DOT }} />
        {/* The sentence gives way first; the time it ends with always shows. */}
        <View className="flex-1 flex-row">
          <Text numberOfLines={1} className="shrink text-callout font-semibold text-white">
            {parts.main}
          </Text>
          {parts.tail ? (
            <Text
              numberOfLines={1}
              className={`text-callout font-semibold ${parts.action ? "text-green-500" : "text-white"}`}
              testID="job-banner-tail"
            >
              {` · ${parts.tail}`}
            </Text>
          ) : null}
        </View>
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors.white} />
      </Pressable>
    </GlassSurface>
  );
}
