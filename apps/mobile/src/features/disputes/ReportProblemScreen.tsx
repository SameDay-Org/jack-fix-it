import { useQueryClient } from "@tanstack/react-query";
import { uuid } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { sessionGeneration } from "@/api";
import { Button, ChoiceCard, Input, Notice, Screen, TextSkeleton } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { BackButton } from "@/features/auth/components/BackButton";
import { isJobRefusal, jobHref, useCustomerJob } from "@/features/jobs/api";
import { MediaPicker, useMediaUpload, type MediaItem } from "@/features/media";
import { isUuid } from "@/features/quotes/navigation";
import { lengthCounter } from "@/features/request/counter";

import {
  DISPUTE_REASONS,
  reportProblem,
  sendFailureOf,
  useCustomerDispute,
  type DisputeReason,
  type SendFailure,
} from "./api";
import { DESCRIPTION_MAX, disputePhotoMax } from "./config";
import { reportOutcome, ReportSummary } from "./ReportStatus";

const TALK_TO_JACK = "/help/contact";
const inFlight = (item: MediaItem) => item.status === "compressing" || item.status === "uploading";

/**
 * "Report a problem" (`/requests/[id]/report`, #75): one full screen over the finished job. What
 * went wrong (one of five reasons), what happened in the customer's words, optional photos, then
 * Send. The API decides whether a report is open (`can_report`, the same window as the
 * confirmation): a screen opened late says reporting is closed and points to Talk to Jack. Once
 * a report exists, sent from here or before, the screen shows it and what happens next.
 */
export function ReportProblemScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = isUuid(id);
  const job = useCustomerJob(id, { enabled: valid, poll: false });
  const view = useCustomerDispute(job.data?.id, { enabled: valid });
  const [sentHere, setSentHere] = useState(false);
  const back = () => (router.canGoBack() ? router.back() : router.replace(jobHref(id)));

  let body: ReactNode;
  if (!valid || (job.data === undefined && isJobRefusal(job.error))) {
    body = (
      <State
        requestId={id}
        title={t("disputes.report.gone.title")}
        body={t("disputes.report.gone.body")}
        testID="report-gone"
      >
        <Button label={t("disputes.report.home")} onPress={() => router.dismissTo("/")} />
      </State>
    );
  } else if (view.data?.dispute) {
    const dispute = view.data.dispute;
    body = (
      <State
        requestId={id}
        title={t(sentHere ? "disputes.sent.title" : "disputes.sent.alreadyTitle")}
        body={dispute.status === "open" ? t("disputes.sent.body") : reportOutcome(t, dispute)}
        testID="report-sent"
      >
        <ReportSummary dispute={dispute} now={view.dataUpdatedAt} testID="report-sent-summary" />
        <Button label={t("disputes.sent.back")} size="lg" onPress={back} testID="report-back" />
      </State>
    );
  } else if (view.data && !view.data.can_report) {
    body = (
      <State
        requestId={id}
        title={t("disputes.report.closed.title")}
        body={t("disputes.report.closed.body")}
        testID="report-closed"
      >
        <Button
          label={t("disputes.report.talkToJack")}
          onPress={() => router.push(TALK_TO_JACK)}
          testID="report-talk"
        />
        <Button label={t("disputes.sent.back")} variant="secondary" onPress={back} />
      </State>
    );
  } else if (view.data && job.data) {
    body = (
      <ReportForm
        jobId={job.data.id}
        requestId={id}
        onSent={() => {
          setSentHere(true);
          announce(t("disputes.sent.title"));
        }}
        onClosed={() => void view.refetch()}
      />
    );
  } else if (job.isError || view.isError) {
    const busy = job.isFetching || view.isFetching;
    body = (
      <State
        requestId={id}
        title={t("disputes.report.loadFailed.title")}
        body={t("disputes.report.loadFailed.body")}
        testID="report-load-failed"
      >
        <Button
          label={t("disputes.report.retry")}
          loading={busy}
          onPress={() => void (job.data ? view.refetch() : job.refetch())}
          testID="report-retry"
        />
      </State>
    );
  } else {
    body = <FormSkeleton requestId={id} />;
  }

  return (
    <Screen bar="light" testID="report-screen">
      {body}
    </Screen>
  );
}

function Header({ title, intro }: { title: string; intro: string }) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-title-1 text-navy-900">
        {title}
      </Text>
      <Text className="text-body text-gray-500">{intro}</Text>
    </View>
  );
}

type StateProps = {
  requestId: string;
  title: string;
  body: string;
  children: ReactNode;
  testID: string;
};

/** A state of the whole screen: what happened, then what the customer can do. */
function State({ requestId, title, body, children, testID }: StateProps) {
  return (
    <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2" testID={testID}>
      <BackButton fallbackHref={jobHref(requestId)} />
      <Header title={title} intro={body} />
      <View className="gap-4">{children}</View>
    </ScrollView>
  );
}

function FormSkeleton({ requestId }: { requestId: string }) {
  return (
    <View className="gap-6 px-4 pt-2" testID="report-loading">
      <BackButton fallbackHref={jobHref(requestId)} />
      <TextSkeleton type="title-1" width="70%" />
      <TextSkeleton type="body" sample="Tell us what went wrong. Our team reviews every report." />
      {DISPUTE_REASONS.map((reason) => (
        <TextSkeleton key={reason} type="headline" width="80%" />
      ))}
    </View>
  );
}

type ReportFormProps = {
  jobId: string;
  requestId: string;
  onSent: () => void;
  /** The API refused the report for the job's state: the screen reads it again and shows why. */
  onClosed: () => void;
};

/**
 * The form. Send checks it first and says what is missing at the field; then one report goes,
 * with this draft's Idempotency-Key (made once, sent with every retry), so a double tap or a
 * retry after a lost answer makes one report.
 */
function ReportForm({ jobId, requestId, onSent, onClosed }: ReportFormProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const client = useQueryClient();
  const [idempotencyKey] = useState(() => uuid.v4());
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [description, setDescription] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const sending = useRef(false);
  const media = useMediaUpload({ purpose: "dispute_photo", max: disputePhotoMax });

  const text = description.trim();
  const over = text.length - DESCRIPTION_MAX;
  const photosWaiting = media.items.some(inFlight);
  const photosFailed = media.items.some((item) => item.status === "failed");
  const complete = reason !== null && text.length > 0 && over <= 0;

  const submit = async () => {
    setChecked(true);
    if (sending.current || !complete || reason === null || photosWaiting || photosFailed) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const body = { reason_code: reason, description: text, photo_keys: media.keys };
      await reportProblem(client, { jobId, requestId, body, idempotencyKey }, sessionGeneration());
      onSent();
    } catch (error) {
      const why = sendFailureOf(error);
      if (why === "closed") onClosed();
      setFailure(why);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      // Padding on both platforms: the app draws edge to edge on Android, where the window no
      // longer resizes for the keyboard; the offset adds back the status bar `Screen` sits under.
      behavior="padding"
      keyboardVerticalOffset={top}
      className="flex-1"
    >
      <ScrollView
        contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        testID="report-form"
      >
        <BackButton fallbackHref={jobHref(requestId)} />
        <Header title={t("disputes.report.title")} intro={t("disputes.report.intro")} />

        <View className="gap-3">
          <Text className="text-headline text-navy-900">{t("disputes.report.reasonLabel")}</Text>
          {checked && reason === null ? (
            <Text className="text-footnote text-danger" testID="report-reason-error">
              {t("disputes.report.reasonMissing")}
            </Text>
          ) : null}
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("disputes.report.reasonLabel")}
            className="gap-3"
            testID="report-reasons"
          >
            {DISPUTE_REASONS.map((code) => (
              <ChoiceCard
                key={code}
                title={t(`disputes.reason.${code}`)}
                selected={reason === code}
                disabled={busy}
                onPress={() => setReason(code)}
                testID={`report-reason-${code}`}
              />
            ))}
          </View>
        </View>

        {/* No native length limit: a long paste is never cut behind the customer's back. Past
            the limit the field says by how much, and Send waits. */}
        <Input
          label={t("disputes.report.descriptionLabel")}
          value={description}
          onChangeText={setDescription}
          hint={t("disputes.report.descriptionHint")}
          error={
            over > 0
              ? t("disputes.report.tooLong", { count: over })
              : checked && text.length === 0
                ? t("disputes.report.descriptionMissing")
                : undefined
          }
          multiline
          counter={lengthCounter(t, text.length, DESCRIPTION_MAX)}
          autoCapitalize="sentences"
          disabled={busy}
          testID="report-description"
        />

        <View className="gap-3">
          <Text className="text-headline text-navy-900">{t("disputes.report.photosLabel")}</Text>
          {checked && (photosWaiting || photosFailed) ? (
            <Notice
              tone="danger"
              title={t(
                photosFailed ? "disputes.report.photosFailed" : "disputes.report.photosWaiting",
              )}
              testID="report-photos-held"
            />
          ) : null}
          <MediaPicker
            upload={media}
            sourceSheet={{
              pathname: "/requests/[id]/report-media-source",
              params: { id: requestId },
            }}
            testID="report-media"
          />
        </View>

        <Text className="text-callout text-gray-500" testID="report-next">
          {t("disputes.report.next")}
        </Text>

        {failure ? (
          <Notice
            tone="info"
            title={t(`disputes.failure.${failure}.title`)}
            body={t(`disputes.failure.${failure}.body`)}
            testID="report-failure"
          />
        ) : null}

        <Button
          label={
            failure === "offline" || failure === "failed"
              ? t("disputes.report.retrySend")
              : t("disputes.report.send")
          }
          size="lg"
          loading={busy}
          onPress={() => void submit()}
          testID="report-send"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
