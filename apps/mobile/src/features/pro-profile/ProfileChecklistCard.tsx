import { useTranslation } from "react-i18next";

import { ChecklistCard } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { useMyProProfile } from "./api";
import { profileChecklist } from "./completeness";

/**
 * "Finish your profile" on the pro's home (#36): what the profile already has and what is still
 * missing (photo, about you, categories, service areas), and the way to the form. It shows only
 * while something is missing: nothing while the profile loads, and nothing once it is complete.
 */
export function ProfileChecklistCard({ testID = "profile-checklist" }: { testID?: string }) {
  const { t } = useTranslation();
  const { data } = useMyProProfile();
  const push = useGuardedPush();
  if (!data) return null;
  const checklist = profileChecklist(data);
  if (checklist.complete) return null;

  return (
    <ChecklistCard
      title={t("proProfile.checklist.title")}
      progress={t("proProfile.checklist.progress", {
        done: checklist.done,
        total: checklist.steps.length,
      })}
      steps={checklist.steps.map(({ step, done }) => {
        const label = t(`proProfile.checklist.steps.${step}`);
        return {
          id: step,
          label,
          done,
          accessibilityLabel: t(
            done ? "proProfile.checklist.stepDone" : "proProfile.checklist.stepTodo",
            { step: label },
          ),
        };
      })}
      actionLabel={t("proProfile.checklist.action")}
      onAction={() => push("/pro/profile")}
      testID={testID}
    />
  );
}
