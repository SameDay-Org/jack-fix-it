import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { Button, Card } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";
import { tokens } from "@/theme";

import { useProProfile } from "./api";
import { profileChecklist, type ProfileStep } from "./completeness";

/** The step mark's side, on the 4-pt grid; the tick inside leaves a 4 dp margin. */
const MARK_SIDE = 24;
const TICK_SIDE = 16;

/** One step: a green tick once it is done, an empty ring until then, and its name. */
function StepRow({ step, done }: { step: ProfileStep; done: boolean }) {
  const { t } = useTranslation();
  const name = t(`proProfile.checklist.steps.${step}`);
  return (
    <View
      accessible
      accessibilityLabel={t(
        done ? "proProfile.checklist.stepDone" : "proProfile.checklist.stepTodo",
        {
          step: name,
        },
      )}
      className="flex-row items-center gap-3"
      testID={`profile-checklist-${step}`}
    >
      <View
        style={{ width: MARK_SIDE, height: MARK_SIDE }}
        className={
          done
            ? "items-center justify-center rounded-pill bg-success"
            : "rounded-pill border-2 border-gray-500/40"
        }
      >
        {done ? <ControlIcon name="check" size={TICK_SIDE} color={tokens.colors.white} /> : null}
      </View>
      <Text
        className={done ? "flex-1 text-callout text-gray-500" : "flex-1 text-callout text-navy-900"}
      >
        {name}
      </Text>
    </View>
  );
}

/**
 * "Finish your profile" on the pro's home (#36): what the profile already has and what is still
 * missing (photo, about you, categories, service areas), and the way to the form. It shows only
 * while something is missing: nothing while the profile loads, and nothing once it is complete.
 */
export function ProfileChecklistCard({ testID = "profile-checklist" }: { testID?: string }) {
  const { t } = useTranslation();
  const { data } = useProProfile();
  const push = useGuardedPush();
  if (!data) return null;
  const checklist = profileChecklist(data);
  if (checklist.complete) return null;

  return (
    <Card testID={testID}>
      <View className="gap-4">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {t("proProfile.checklist.title")}
          </Text>
          <Text className="text-callout text-gray-500" testID={`${testID}-progress`}>
            {t("proProfile.checklist.progress", {
              done: checklist.done,
              total: checklist.steps.length,
            })}
          </Text>
        </View>
        <View className="gap-3">
          {checklist.steps.map(({ step, done }) => (
            <StepRow key={step} step={step} done={done} />
          ))}
        </View>
        <Button
          label={t("proProfile.checklist.action")}
          onPress={() => push("/pro/profile")}
          testID={`${testID}-action`}
        />
      </View>
    </Card>
  );
}
