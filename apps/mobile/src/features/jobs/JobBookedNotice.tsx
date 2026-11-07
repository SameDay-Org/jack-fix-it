import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { jobHref, useCustomerJob } from "./api";
import { useMinuteClock } from "./clock";
import { jobsConfig } from "./config";
import { jobText } from "./phase";

export type JobBookedNoticeProps = {
  requestId: string;
  /** The request has an accepted quote: only then can a job exist. */
  accepted: boolean;
};

/**
 * On an accepted request's detail (`/requests/[id]`): once the payment created the job, a calm
 * "Your job is booked" with where it stands and the way to follow it. Nothing before that (the
 * payment step is the quote's own), and nothing on a request with no accepted quote. Asked on
 * mount and again on return (a payment sheet closed over it); never polled from here.
 */
export function JobBookedNotice({ requestId, accepted }: JobBookedNoticeProps) {
  const { t } = useTranslation();
  const { data } = useCustomerJob(requestId, { enabled: accepted, poll: false });
  const now = useMinuteClock();
  const push = useGuardedPush();
  if (!accepted || !data) return null;

  return (
    <View className="gap-4 rounded-xl bg-navy-900 p-5" testID="job-booked">
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-title-2 text-white">
          {t("jobs.booked.title")}
        </Text>
        <Text className="text-callout text-white/80">
          {jobText(t, data, now, jobsConfig.etaCloseMinutes).headline}
        </Text>
      </View>
      <Button
        label={t("jobs.booked.follow")}
        onPress={() => push(jobHref(requestId))}
        testID="job-booked-follow"
      />
    </View>
  );
}
