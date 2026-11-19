import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { AccessoryBanner } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { jobHref } from "./api";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { bannerParts, bannerText, type ActiveJob } from "./phase";

// Past this the unread count reads "99+".
const BADGE_MAX = 99;

export type JobBannerProps = {
  active: ActiveJob;
  /** When the job was last answered (`useActiveJob`). */
  updatedAt: number;
};

/**
 * The tabs' one line about the job under way ("Dan is on the way · 12 min"; when it does not fit,
 * the sentence is cut short, never the time it ends with), the kit's `AccessoryBanner` over the
 * tab bar, with the pro's unread messages as a small count (#74). A tap opens the ongoing job
 * screen. It never carries the arrival code.
 */
export function JobBanner({ active, updatedAt }: JobBannerProps) {
  const { t } = useTranslation();
  const { job } = active;
  const now = useMinuteClock(updatedAt, job.eta_at === null ? null : Date.parse(job.eta_at));
  const push = useGuardedPush();
  const text = bannerText(t, job, now, jobsConfig.etaCloseMinutes);
  const parts = bannerParts(t, job, now, jobsConfig.etaCloseMinutes);
  if (text === null || parts === null) return null;
  const unread = job.unread_messages;

  return (
    <AccessoryBanner
      main={parts.main}
      tail={parts.tail}
      tailIsAction={parts.action}
      accessibilityLabel={
        unread > 0 ? `${text}, ${t("jobs.banner.unread", { count: unread })}` : text
      }
      accessibilityHint={t("jobs.banner.hint")}
      onPress={() => push(jobHref(active.requestId))}
      badge={
        unread > 0 ? (
          <View
            className="min-h-6 min-w-6 items-center justify-center rounded-pill bg-green-500 px-1.5"
            testID="job-banner-unread"
          >
            <Text className="text-caption font-semibold text-navy-900">
              {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
            </Text>
          </View>
        ) : null
      }
      testID="job-banner"
    />
  );
}
