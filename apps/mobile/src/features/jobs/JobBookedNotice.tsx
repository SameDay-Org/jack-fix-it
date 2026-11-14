import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { jobHref, useCustomerJob } from "./api";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { isActive, jobPhase, jobText } from "./phase";

export type JobBookedNoticeProps = {
  requestId: string;
  /** The request has an accepted quote: only then can a job exist. */
  accepted: boolean;
};

/**
 * On an accepted request's detail (`/requests/[id]`): once the payment created the job, a calm
 * "Your job is booked" with where it stands and the way to follow it; once the job is past
 * (done, cancelled, a problem), its own headline and the way to see it. Nothing before that (the
 * payment step is the quote's own), and nothing on a request with no accepted quote. Asked on
 * mount and again on return; never polled from here: a job the accepted card finds fills it when
 * it has none (`features/payments`), so it is the one place that says "booked".
 */
export function JobBookedNotice({ requestId, accepted }: JobBookedNoticeProps) {
  const { t } = useTranslation();
  const { data, dataUpdatedAt } = useCustomerJob(requestId, { enabled: accepted, poll: false });
  const now = useMinuteClock(dataUpdatedAt);
  const push = useGuardedPush();
  if (!accepted || !data) return null;
  // While the job is under way it is "booked"; after that the notice says where it ended.
  const { headline, support } = jobText(t, data, now, jobsConfig.etaCloseMinutes);
  const ongoing = isActive(data);
  // Under "booked", a scheduled job's headline would only say it again: its start says more.
  const line = !ongoing || jobPhase(data) === "scheduled" ? support : headline;

  return (
    <View className="gap-4 rounded-xl bg-navy-900 p-5" testID="job-booked">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-title-2 text-white">
          {ongoing ? t("jobs.booked.title") : headline}
        </Text>
        <Text className="text-callout text-white/80">{line}</Text>
      </View>
      <Button
        label={ongoing ? t("jobs.booked.follow") : t("jobs.booked.see")}
        onPress={() => push(jobHref(requestId))}
        testID="job-booked-follow"
      />
    </View>
  );
}
