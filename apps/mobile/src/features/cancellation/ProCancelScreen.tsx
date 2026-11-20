import { useQueryClient } from "@tanstack/react-query";
import { uuid } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError, sessionGeneration } from "@/api";
import { Button, ChoiceCard, Input, Notice, Screen } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { BackButton } from "@/features/auth/components/BackButton";
import { proJobHref, useProJob } from "@/features/pro-jobs/api";
import { customerName } from "@/features/pro-jobs/format";
import { lengthCounter } from "@/features/request/counter";

import {
  cancelProJob,
  mayCancel,
  PRO_CANCEL_REASONS,
  proCancelFailureOf,
  type ProCancelFailure,
  type ProCancelReason,
  type ProCancellation,
} from "./api";
import { CancelHeader, CancelSkeleton, CancelState } from "./CancelState";
import { NOTE_MAX } from "./config";

const TALK_TO_JACK = "/help/contact";
/** The failures after which the same cancel goes again: the button says "Try again". */
const SEND_AGAIN: ReadonlySet<ProCancelFailure> = new Set(["offline", "rateLimited", "failed"]);
/** The failures the form says in its notice (a needed review takes the whole screen). */
type FormFailure = Exclude<ProCancelFailure, "review">;

/** No job of this pro with that id (404), or the one signed in is not a pro (403). */
const notTheirs = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

/** A cancelled job's words on the pro's side: who cancelled it, and that the customer was told. */
const cancelledCopy = (cancellation: Pick<ProCancellation, "cancelled_by">) =>
  cancellation.cancelled_by === "pro" ? "byYou" : "byCustomer";

/**
 * The pro's "Cancel job" (`/jobs/[id]/cancel`, #69 part 2): one full screen over their job, for a
 * scheduled or on-the-way job (arrived included). Why (one of four reasons, required), an optional
 * note for the team, and what happens, as the API's rule has it: the customer is never charged
 * (their whole payment goes back) and the pro is not paid for the job. "Cancel the job" sends;
 * "Keep the job" goes back. A job that cannot be cancelled now says so and points to Talk to
 * Jack; a cancelled job, here or before, says who cancelled it.
 */
export function ProCancelScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const job = useProJob(id);
  // The cancel sent from here and the API's word that staff must look first, each kept with its
  // job: a link can reuse this screen for another job, which must not inherit them.
  const [sent, setSent] = useState<{ jobId: string; cancellation: ProCancellation } | null>(null);
  const sentHere = sent?.jobId === id ? sent.cancellation : null;
  const [reviewFor, setReviewFor] = useState<string | null>(null);
  const cancelled = sentHere ?? job.data?.cancellation ?? null;
  // Inside a sentence in both languages ("tu cliente").
  const name = (job.data && customerName(job.data)) ?? t("chat.peer.customer.inline");
  const jobBack = proJobHref(id);
  const back = () => (router.canGoBack() ? router.back() : router.replace(jobBack));

  let body: ReactNode;
  if (!job.valid || (job.data === undefined && notTheirs(job.error))) {
    body = (
      <CancelState
        back={jobBack}
        title={t("proJobs.screen.gone.title")}
        body={t("proJobs.screen.gone.body")}
        testID="cancel-gone"
      >
        <Button label={t("proJobs.screen.gone.home")} onPress={() => router.dismissTo("/")} />
      </CancelState>
    );
  } else if (cancelled) {
    const copy = cancelledCopy(cancelled);
    body = (
      <CancelState
        back={jobBack}
        title={t(`cancellation.pro.${copy}.title`)}
        body={t(`cancellation.pro.${copy}.body`, { name })}
        testID="cancel-sent"
      >
        <Button label={t("cancellation.sent.back")} size="lg" onPress={back} testID="cancel-back" />
      </CancelState>
    );
  } else if (job.data && (!mayCancel(job.data.status) || reviewFor === id)) {
    const copy = reviewFor === id ? "review" : "closed";
    body = (
      <CancelState
        back={jobBack}
        title={t(`cancellation.${copy}.title`)}
        body={t(`cancellation.${copy}.body`)}
        announced={copy === "review"}
        testID="cancel-closed"
      >
        <Button
          label={t("cancellation.talkToJack")}
          onPress={() => router.push(TALK_TO_JACK)}
          testID="cancel-talk"
        />
        <Button label={t("cancellation.sent.back")} variant="secondary" onPress={back} />
      </CancelState>
    );
  } else if (job.data) {
    body = (
      <ProCancelForm
        // A form per job: its reason, note and Idempotency-Key never carry over to another.
        key={id}
        jobId={job.data.id}
        name={name}
        onSent={(cancellation) => {
          setSent({ jobId: id, cancellation });
          announce(t(`cancellation.pro.${cancelledCopy(cancellation)}.title`));
        }}
        onReview={() => setReviewFor(id)}
        onChanged={() => void job.refetch()}
        onKeep={back}
      />
    );
  } else if (job.isError) {
    body = (
      <CancelState
        back={jobBack}
        title={t("cancellation.loadFailed.title")}
        body={t("cancellation.loadFailed.body")}
        announced
        testID="cancel-load-failed"
      >
        <Button
          label={t("cancellation.retry")}
          loading={job.isFetching}
          onPress={() => void job.refetch()}
          testID="cancel-retry"
        />
      </CancelState>
    );
  } else {
    body = <CancelSkeleton back={jobBack} />;
  }

  return (
    <Screen bar="light" testID="pro-cancel-screen">
      {body}
    </Screen>
  );
}

type ProCancelFormProps = {
  jobId: string;
  /** The customer, inside a sentence. */
  name: string;
  onSent: (cancellation: ProCancellation) => void;
  /** The API said staff must look at the job's payment before it can be cancelled. */
  onReview: () => void;
  /** The API's answer changed the picture: the job moved on, or is no longer this pro's. */
  onChanged: () => void;
  onKeep: () => void;
};

/**
 * The form. "Cancel the job" checks it first and says what is missing at the field; then one
 * cancel goes with this screen's Idempotency-Key (made once, sent with every retry: after a lost
 * connection, or after the API asked to wait), so a double tap or a retry cancels once.
 */
function ProCancelForm({ jobId, name, onSent, onReview, onChanged, onKeep }: ProCancelFormProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const client = useQueryClient();
  const [idempotencyKey] = useState(() => uuid.v4());
  const [reason, setReason] = useState<ProCancelReason | null>(null);
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FormFailure | null>(null);
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
      const body = { reason_code: reason, note: text.length > 0 ? text : null };
      onSent(await cancelProJob(client, { jobId, body, idempotencyKey }, sessionGeneration()));
    } catch (error) {
      const why = proCancelFailureOf(error);
      if (why === "review") return onReview();
      if (why === "closed") onChanged();
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
        <BackButton fallbackHref={proJobHref(jobId)} />
        <CancelHeader
          title={t("cancellation.title")}
          intro={t("cancellation.pro.intro", { name })}
        />

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
            {PRO_CANCEL_REASONS.map((code) => (
              <ChoiceCard
                key={code}
                title={t(`cancellation.pro.reason.${code}`)}
                selected={reason === code}
                disabled={busy}
                onPress={() => setReason(code)}
                testID={`cancel-reason-${code}`}
              />
            ))}
          </View>
        </View>

        {/* No native length limit: a long paste is never cut behind the pro's back. Past the
            limit the field says by how much, and the cancel waits. */}
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
            {t("cancellation.pro.costTitle")}
          </Text>
          <Text className="text-body text-navy-900" testID="cancel-cost-statement">
            {t("cancellation.pro.cost", { name })}
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
              failure && SEND_AGAIN.has(failure)
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
