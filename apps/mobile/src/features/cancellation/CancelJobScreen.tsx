import { useQueryClient } from "@tanstack/react-query";
import { uuid } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { sessionGeneration } from "@/api";
import { Button, ChoiceCard, Input, Notice, Screen, TextSkeleton } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { BackButton } from "@/features/auth/components/BackButton";
import { isJobRefusal, jobHref, useCustomerJob } from "@/features/jobs/api";
import { isUuid } from "@/features/quotes/navigation";
import { lengthCounter } from "@/features/request/counter";

import {
  CANCEL_REASONS,
  cancelFailureOf,
  cancelJob,
  mayCancel,
  refusalOf,
  useCancelPreview,
  type CancelFailure,
  type CancelPreview,
  type CancelReason,
  type Cancellation,
} from "./api";
import { costStatement, moneyLines } from "./CancellationStatus";
import { NOTE_MAX } from "./config";

const TALK_TO_JACK = "/help/contact";

/**
 * "Cancel job" (`/requests/[id]/cancel`, #69): one full screen over the job. Why (one of four
 * reasons), an optional note, and what cancelling costs now in the API's own numbers (its
 * preview: free before the pro is on the way, then a share of the job price). "Cancel the job"
 * sends; "Keep the job" goes back. A job the API will not cancel now says so and points to Talk
 * to Jack; a cancelled job, here or before, shows where its money stands.
 */
export function CancelJobScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = isUuid(id);
  const job = useCustomerJob(id, { enabled: valid, poll: false });
  const cancellable = job.data !== undefined && mayCancel(job.data.status);
  const preview = useCancelPreview(job.data?.id, { enabled: valid && cancellable });
  // The cancel sent from here, kept with its request: a link can reuse this screen for another
  // job (new params, same screen), which must not inherit it.
  const [sent, setSent] = useState<{ requestId: string; cancellation: Cancellation } | null>(null);
  const sentHere = sent?.requestId === id ? sent.cancellation : null;
  const refusal = refusalOf(preview.error);
  const cancelled = sentHere ?? job.data?.cancellation ?? null;
  const back = () => (router.canGoBack() ? router.back() : router.replace(jobHref(id)));
  const reread = () => void Promise.all([job.refetch(), preview.refetch()]);

  let body: ReactNode;
  if (!valid || (job.data === undefined && isJobRefusal(job.error))) {
    body = (
      <State
        requestId={id}
        title={t("jobs.notFound.title")}
        body={t("jobs.notFound.body")}
        testID="cancel-gone"
      >
        <Button label={t("jobs.notFound.home")} onPress={() => router.dismissTo("/")} />
      </State>
    );
  } else if (cancelled) {
    body = (
      <State
        requestId={id}
        title={t(sentHere ? "cancellation.sent.title" : "jobs.headline.cancelled")}
        body={sentHere ? t("cancellation.sent.body") : ""}
        testID="cancel-sent"
      >
        {moneyLines(t, cancelled, sentHere?.currency).map((line) => (
          <Text key={line} className="text-body text-navy-900">
            {line}
          </Text>
        ))}
        <Button label={t("cancellation.sent.back")} size="lg" onPress={back} testID="cancel-back" />
      </State>
    );
  } else if (job.data && (!cancellable || refusal)) {
    const copy = refusal === "needsReview" ? "review" : "closed";
    body = (
      <State
        requestId={id}
        title={t(`cancellation.${copy}.title`)}
        body={t(`cancellation.${copy}.body`)}
        testID="cancel-closed"
      >
        <Button
          label={t("cancellation.talkToJack")}
          onPress={() => router.push(TALK_TO_JACK)}
          testID="cancel-talk"
        />
        <Button label={t("cancellation.sent.back")} variant="secondary" onPress={back} />
      </State>
    );
  } else if (job.data && preview.data) {
    body = (
      <CancelForm
        // A form per job: its reason, note and Idempotency-Key never carry over to another.
        key={id}
        jobId={job.data.id}
        requestId={id}
        preview={preview.data}
        onSent={(cancellation) => {
          setSent({ requestId: id, cancellation });
          announce(t("cancellation.sent.title"));
        }}
        onChanged={reread}
        onKeep={back}
      />
    );
  } else if (job.isError || preview.isError) {
    body = (
      <State
        requestId={id}
        title={t("cancellation.loadFailed.title")}
        body={t("cancellation.loadFailed.body")}
        testID="cancel-load-failed"
      >
        <Button
          label={t("cancellation.retry")}
          loading={job.isFetching || preview.isFetching}
          onPress={() => void (job.data ? preview.refetch() : job.refetch())}
          testID="cancel-retry"
        />
      </State>
    );
  } else {
    body = <FormSkeleton requestId={id} />;
  }

  return (
    <Screen bar="light" testID="cancel-screen">
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
      {intro ? <Text className="text-body text-gray-500">{intro}</Text> : null}
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
    <View className="gap-6 px-4 pt-2" testID="cancel-loading">
      <BackButton fallbackHref={jobHref(requestId)} />
      <TextSkeleton type="title-1" width="60%" />
      <TextSkeleton type="body" sample="Tell us why, and check what it costs." />
      {CANCEL_REASONS.map((reason) => (
        <TextSkeleton key={reason} type="headline" width="70%" />
      ))}
    </View>
  );
}

type CancelFormProps = {
  jobId: string;
  requestId: string;
  preview: CancelPreview;
  onSent: (cancellation: Cancellation) => void;
  /** The API's answer changed the picture (the cost, or whether the job can be cancelled). */
  onChanged: () => void;
  onKeep: () => void;
};

/**
 * The form. "Cancel the job" checks it first and says what is missing at the field; then one
 * cancel goes with this screen's Idempotency-Key (made once, sent with every retry) and the
 * preview's fee as the amount the customer agreed to, so a double tap or a retry cancels once and
 * a cost that changed in between is never taken unseen.
 */
function CancelForm({ jobId, requestId, preview, onSent, onChanged, onKeep }: CancelFormProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const client = useQueryClient();
  const [idempotencyKey] = useState(() => uuid.v4());
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CancelFailure | null>(null);
  const sending = useRef(false);
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Where each field starts in the form, to scroll to what is missing.
  const at = useRef({ reason: 0, note: 0 });

  const text = note.trim();
  const over = text.length - NOTE_MAX;

  /** Brings the first field the check found wanting into view, and says what it needs. */
  const showMissing = () => {
    const field = reason === null ? "reason" : "note";
    scroll.current?.scrollTo({ y: at.current[field], animated: !reduceMotion });
    announce(
      reason === null
        ? t("cancellation.reasonMissing")
        : t("cancellation.tooLong", { count: over }),
    );
  };

  const submit = async () => {
    setChecked(true);
    if (reason === null || over > 0) return showMissing();
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const body = {
        reason_code: reason,
        note: text.length > 0 ? text : null,
        expected_fee_cents: preview.fee_cents,
      };
      onSent(
        await cancelJob(client, { jobId, requestId, body, idempotencyKey }, sessionGeneration()),
      );
    } catch (error) {
      const why = cancelFailureOf(error);
      if (why === "feeChanged" || why === "closed") onChanged();
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
        ref={scroll}
        contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        testID="cancel-form"
      >
        <BackButton fallbackHref={jobHref(requestId)} />
        <Header title={t("cancellation.title")} intro={t("cancellation.intro")} />

        <View
          className="gap-3"
          onLayout={(event) => (at.current.reason = event.nativeEvent.layout.y)}
        >
          <Text className="text-headline text-navy-900">{t("cancellation.reasonLabel")}</Text>
          {checked && reason === null ? (
            <Text className="text-footnote text-danger" testID="cancel-reason-error">
              {t("cancellation.reasonMissing")}
            </Text>
          ) : null}
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("cancellation.reasonLabel")}
            className="gap-3"
            testID="cancel-reasons"
          >
            {CANCEL_REASONS.map((code) => (
              <ChoiceCard
                key={code}
                title={t(`cancellation.reason.${code}`)}
                selected={reason === code}
                disabled={busy}
                onPress={() => setReason(code)}
                testID={`cancel-reason-${code}`}
              />
            ))}
          </View>
        </View>

        {/* No native length limit: a long paste is never cut behind the customer's back. Past
            the limit the field says by how much, and the cancel waits. */}
        <View onLayout={(event) => (at.current.note = event.nativeEvent.layout.y)}>
          <Input
            label={t("cancellation.noteLabel")}
            value={note}
            onChangeText={setNote}
            hint={t("cancellation.noteHint")}
            error={over > 0 ? t("cancellation.tooLong", { count: over }) : undefined}
            multiline
            counter={lengthCounter(t, text.length, NOTE_MAX)}
            autoCapitalize="sentences"
            disabled={busy}
            testID="cancel-note"
          />
        </View>

        <View className="gap-2" testID="cancel-cost">
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {t("cancellation.costTitle")}
          </Text>
          <Text className="text-body text-navy-900" testID="cancel-cost-statement">
            {costStatement(t, preview)}
          </Text>
        </View>

        {failure ? (
          <Notice
            tone="info"
            title={t(`cancellation.failure.${failure}.title`)}
            body={t(`cancellation.failure.${failure}.body`)}
            testID="cancel-failure"
          />
        ) : null}

        <View className="gap-3">
          <Button
            label={
              failure === "offline" || failure === "failed"
                ? t("cancellation.retrySend")
                : t("cancellation.confirm")
            }
            size="lg"
            loading={busy}
            onPress={() => void submit()}
            testID="cancel-confirm"
          />
          <Button
            label={t("cancellation.keep")}
            variant="secondary"
            size="lg"
            disabled={busy}
            onPress={onKeep}
            testID="cancel-keep"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
