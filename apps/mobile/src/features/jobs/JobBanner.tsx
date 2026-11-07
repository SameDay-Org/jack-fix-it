import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { GlassSurface, useFlag } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";
import { pressedTransform, tokens, withOpacity } from "@/theme";

import { jobHref } from "./api";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { bannerText, type ActiveJob } from "./phase";

const CHEVRON = 20;
const DOT = 10;
const RIPPLE_OPACITY = 0.15;
const RIPPLE = { color: withOpacity("white", RIPPLE_OPACITY) };

export type JobBannerProps = { active: ActiveJob };

/**
 * The tabs' one line about the job under way ("Dan is on the way · 12 min"), floating over the
 * tab bar as its accessory: a dark pill on the controls layer (Liquid Glass where the device
 * draws it) with a green dot, the line and a chevron. A tap opens the ongoing job screen. It
 * never carries the arrival code.
 */
export function JobBanner({ active }: JobBannerProps) {
  const { t } = useTranslation();
  const now = useMinuteClock();
  const [pressed, pressIn, pressOut] = useFlag();
  const push = useGuardedPush();
  const text = bannerText(t, active.job, now, jobsConfig.etaCloseMinutes);
  if (text === null) return null;

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
        <Text numberOfLines={1} className="flex-1 text-callout font-semibold text-white">
          {text}
        </Text>
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors.white} />
      </Pressable>
    </GlassSurface>
  );
}
