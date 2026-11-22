import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";

import type { ProJob } from "@/features/pro-jobs/phase";
import { useGuardedPush } from "@/features/quotes/navigation";

import { mayCancel, proCancelHref } from "./api";

/**
 * "Cancel job" on the pro's job screen: a quiet text action, never the step's primary button,
 * while the job is scheduled or on the way (arrived included), as the API allows. Past that the
 * API refuses (`cancel_not_allowed`), and the action is left out.
 */
export function ProCancelEntry({ job }: { job: Pick<ProJob, "id" | "status"> }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  if (!mayCancel(job.status)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => push(proCancelHref(job.id))}
      className="min-h-12 justify-center self-start"
      testID="pro-job-cancel"
    >
      <Text className="text-callout font-semibold text-navy-900 underline">
        {t("cancellation.entry")}
      </Text>
    </Pressable>
  );
}
