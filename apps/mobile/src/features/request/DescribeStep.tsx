import { router, useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View } from "react-native";

import { Button, Input, Notice } from "@/components/ui";
import { MediaPicker, type MediaItem } from "@/features/media";

import { lengthCounter } from "./counter";
import { clearRefusal, setDescription, useRequestDraft } from "./requestDraft";
import { useRequestFlowContext } from "./RequestFlowLayout";
import { StepScreen } from "./StepScreen";
import { nextStep, stepHref, type StepId } from "./steps";

/** RequestCreate.description: 1 to 2000 characters. */
export const DESCRIPTION_MAX = 2000;

const inFlight = (item: MediaItem) => item.status === "compressing" || item.status === "uploading";

type DescribeStepProps = { steps: readonly StepId[] };

/**
 * "What's going on?": the description (required, a counter near the limit) and the photos and
 * videos, through the media feature (optional; each upload starts as it is picked). Continue
 * waits for uploads still running and goes on when they finish; a failed one holds it until the
 * customer retries or removes it, so a file never goes missing from the request unnoticed.
 */
export function DescribeStep({ steps }: DescribeStepProps) {
  const { t } = useTranslation();
  const { media } = useRequestFlowContext();
  const navigation = useNavigation();
  const description = useRequestDraft((draft) => draft.description);
  const refused = useRequestDraft((draft) => draft.refusal?.step === "describe");
  const [checked, setChecked] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failedShown, setFailedShown] = useState(false);
  const pending = media.items.some(inFlight);
  const failed = media.items.some((item) => item.status === "failed");
  const blank = description.trim() === "";

  const goNext = () => {
    // Going on is the answer to the server's objection here (the files were changed or kept).
    clearRefusal("describe");
    const next = nextStep("describe", steps);
    if (next) router.push(stepHref(next, steps));
  };

  const holdForFailed = () => {
    setFailedShown(true);
    AccessibilityInfo.announceForAccessibility(t("request.describe.uploadFailedTitle"));
  };

  const onContinue = () => {
    if (blank) {
      setChecked(true);
      AccessibilityInfo.announceForAccessibility(t("request.describe.required"));
      return;
    }
    if (failed) holdForFailed();
    else if (pending) {
      setWaiting(true);
      AccessibilityInfo.announceForAccessibility(t("request.describe.waiting"));
    } else goNext();
  };

  // Waiting on uploads: go on once the last one is done, or stop at a failure. The effect fires
  // only when the uploads settle; it reads the latest render's handlers through a ref.
  const settled = useRef(() => {});
  useEffect(() => {
    settled.current = () => {
      setWaiting(false);
      // The text may have been cleared, or the media sheet opened, while the files uploaded: check
      // again, and go on only from this step.
      if (blank) {
        setChecked(true);
        AccessibilityInfo.announceForAccessibility(t("request.describe.required"));
      } else if (failed) holdForFailed();
      else if (navigation.isFocused()) goNext();
    };
  });
  useEffect(() => {
    if (waiting && !pending) settled.current();
  }, [waiting, pending]);

  return (
    <StepScreen
      step="describe"
      steps={steps}
      title={t("request.describe.title")}
      support={t("request.describe.support")}
      action={
        <Button
          label={t("common.continue")}
          size="lg"
          loading={waiting}
          onPress={onContinue}
          testID="describe-continue"
        />
      }
      refusal={refused ? t("request.describe.refusedTitle") : undefined}
      testID="request-describe"
    >
      <Input
        label={t("request.describe.label")}
        value={description}
        onChangeText={setDescription}
        error={checked && blank ? t("request.describe.required") : undefined}
        multiline
        maxLength={DESCRIPTION_MAX}
        counter={lengthCounter(t, description.length, DESCRIPTION_MAX)}
        autoCapitalize="sentences"
        testID="describe-text"
      />
      <View className="gap-3">
        <Text className="text-headline text-navy-900">
          {t("request.optionalLabel", { label: t("request.describe.mediaTitle") })}
        </Text>
        {refused ? (
          <Notice
            tone="danger"
            title={t("request.describe.refusedTitle")}
            body={t("request.describe.refusedBody")}
            testID="describe-refused"
          />
        ) : null}
        {failedShown && failed ? (
          <Notice
            tone="danger"
            title={t("request.describe.uploadFailedTitle")}
            body={t("request.describe.uploadFailedBody")}
            testID="describe-upload-failed"
          />
        ) : null}
        <MediaPicker upload={media} sourceSheet="/request/media-source" testID="describe-media" />
      </View>
    </StepScreen>
  );
}
