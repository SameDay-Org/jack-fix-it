import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { sessionGeneration } from "@/api";
import { Button, Input, Notice, TextSkeleton } from "@/components/ui";
import { sentDay } from "@/features/history/format";
import { PhotoTiles } from "@/features/media";
import { useRefreshExpiredMedia } from "@/features/opportunities/useOpportunity";
import { lengthCounter } from "@/features/request/counter";

import {
  replyToProblem,
  sendFailureOf,
  useProDispute,
  type ProDispute,
  type SendFailure,
} from "./api";
import { REPLY_MAX } from "./config";
import { ReportSummary } from "./ReportStatus";

/**
 * "The customer reported a problem" on the pro's job screen (#75), for a disputed job: the
 * reason, the customer's words as the API stored them (contact details masked), the photos'
 * privacy-safe copies (never an original), where it stands, and the pro's one reply for the team
 * that reviews both sides. Once sent, the reply shows read-only.
 */
export function ReportedProblem({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const { data, isError, isFetching, refetch, dataUpdatedAt } = useProDispute(jobId);
  const dispute = data?.dispute ?? null;
  // The photos' signed URLs are asked for again when one expires on screen.
  const now = useRefreshExpiredMedia(dispute?.photos, dataUpdatedAt, refetch);
  if (data && dispute === null) return null;

  return (
    <View className="gap-4" testID="pro-job-report">
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-title-2 text-navy-900">
          {t("disputes.pro.title")}
        </Text>
        <Text className="text-callout text-gray-500">{t("disputes.pro.review")}</Text>
      </View>
      {dispute && data ? (
        <>
          <ReportSummary dispute={dispute} now={dataUpdatedAt} testID="pro-job-report-summary" />
          <Text className="text-body text-navy-900" testID="pro-job-report-description">
            {dispute.description}
          </Text>
          {dispute.photos.length > 0 ? (
            <PhotoTiles
              photos={dispute.photos}
              now={now}
              label={(index, total) => t("disputes.pro.photo", { index: index + 1, total })}
              testID="pro-job-report-photos"
            />
          ) : null}
          {dispute.photos_pending > 0 ? (
            <Text className="text-footnote text-gray-500" testID="pro-job-report-pending">
              {t("disputes.pro.photosPending", { count: dispute.photos_pending })}
            </Text>
          ) : null}
          <Reply
            jobId={jobId}
            dispute={dispute}
            canReply={data.can_reply}
            now={dataUpdatedAt}
            onClosed={() => void refetch()}
          />
        </>
      ) : isError ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: isFetching }}
          disabled={isFetching}
          onPress={() => void refetch()}
          className="min-h-12 justify-center self-start"
          testID="pro-job-report-error"
        >
          <Text className="text-callout text-gray-500">
            {`${t("disputes.pro.loadFailed")} `}
            <Text className="font-semibold text-navy-900 underline">
              {t("disputes.status.retry")}
            </Text>
          </Text>
        </Pressable>
      ) : (
        <View className="gap-2" testID="pro-job-report-loading">
          <TextSkeleton type="headline" width="60%" />
          <TextSkeleton type="body" sample={t("disputes.pro.review")} />
        </View>
      )}
    </View>
  );
}

type ReplyProps = {
  jobId: string;
  dispute: ProDispute;
  canReply: boolean;
  now: number;
  /** The API refused the reply (already given, or the report resolved): read it again. */
  onClosed: () => void;
};

/** The pro's one answer: a box while they may still send it, then the sent text, read-only. */
function Reply({ jobId, dispute, canReply, now, onClosed }: ReplyProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const sending = useRef(false);
  const text = message.trim();
  const over = text.length - REPLY_MAX;

  if (dispute.reply !== null) {
    return (
      <View
        accessible
        className="gap-1 border-t border-gray-500/15 pt-4"
        testID="pro-job-report-reply-sent"
      >
        <Text className="text-headline text-navy-900">{t("disputes.pro.replyTitle")}</Text>
        {dispute.replied_at ? (
          <Text className="text-footnote text-gray-500">{sentDay(t, dispute.replied_at, now)}</Text>
        ) : null}
        <Text className="text-body text-navy-900">{dispute.reply}</Text>
      </View>
    );
  }
  if (!canReply) return null;

  const submit = async () => {
    setChecked(true);
    if (sending.current || text.length === 0 || over > 0) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await replyToProblem(client, jobId, text, sessionGeneration());
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
    <View className="gap-3 border-t border-gray-500/15 pt-4" testID="pro-job-report-reply">
      <Input
        label={t("disputes.pro.replyLabel")}
        value={message}
        onChangeText={setMessage}
        hint={t("disputes.pro.replyHint")}
        error={
          over > 0
            ? t("disputes.report.tooLong", { count: over })
            : checked && text.length === 0
              ? t("disputes.pro.replyMissing")
              : undefined
        }
        multiline
        counter={lengthCounter(t, text.length, REPLY_MAX)}
        autoCapitalize="sentences"
        disabled={busy}
        testID="pro-job-report-reply-input"
      />
      {failure ? (
        <Notice
          tone="info"
          title={t(`disputes.failure.${failure}.title`)}
          body={t(`disputes.failure.${failure}.body`)}
          testID="pro-job-report-reply-failure"
        />
      ) : null}
      <Button
        label={t("disputes.pro.replySend")}
        variant="secondary"
        loading={busy}
        onPress={() => void submit()}
        testID="pro-job-report-reply-send"
      />
    </View>
  );
}
