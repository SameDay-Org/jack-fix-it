import type { TFunction } from "i18next";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ChatBubble, ReceiptTicks } from "@/components/ui";
import { formatInstantDay, formatTimeOfDay } from "@/features/opportunities/format";
import { formatLocale } from "@/features/quotes/format";

import { receiptOf, type Row } from "./thread";

const DAY_MS = 24 * 60 * 60_000;
// The line under a bubble: a failed send, or the masking note. The color is separate: two text
// colors on one element are resolved by stylesheet order, not class order.
const META_BASE = "mt-1 px-1 text-caption";
const META = `${META_BASE} text-gray-500`;
const META_DANGER = `${META_BASE} text-danger`;
// The time and receipt inside a bubble, at its bottom right. Muted text on navy is white at
// reduced opacity (gray-500 is forbidden on navy); on the white bubble it is gray-500.
const STAMP = "mt-0.5 flex-row items-center justify-end gap-1 self-end";
const TIME_ON_MINE = "text-caption text-white/70";
const TIME_ON_THEIRS = "text-caption text-gray-500";

/** The local midnight starting an instant's day. */
const startOfDay = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** A day's heading: "Today", "Yesterday", or the day itself ("Fri, Oct 30"). */
export function dayLabel(t: TFunction, at: number, now: number, locale = formatLocale()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return t("chat.day.today");
  if (days === 1) return t("chat.day.yesterday");
  return formatInstantDay(at, locale);
}

export type MessageRowProps = {
  row: Row;
  /** The other side's name as a sentence starts with it, for what a screen reader says. */
  peerName: string;
  /** The day headings are worded against this clock (the newest answer's time). */
  now: number;
  /** The chat is read-only: a failed send can no longer go, so it offers no retry. */
  closed: boolean;
  onRetry: (localId: string) => void;
};

/**
 * One row of the conversation: a day's heading, or a message bubble on its sender's side. Each
 * bubble ends with its time at the bottom right and, on mine, the receipt (a clock while it is on
 * its way, then one tick, two ticks, two light-blue ticks: sent, delivered, seen). The newest
 * bubble of a run carries the tail. Under mine: a failed send says so (tap to try again), and a
 * message the API masked says that. Each bubble reads as one element: who, when, the text, then
 * the receipt.
 */
export const MessageRow = memo(function MessageRow({
  row,
  peerName,
  now,
  closed,
  onRetry,
}: MessageRowProps) {
  const { t } = useTranslation();
  if (row.kind === "day") {
    const label = dayLabel(t, row.at, now);
    return (
      <View className="items-center py-3" accessibilityRole="header" accessible>
        <View className="rounded-pill bg-white px-3 py-1">
          <Text className="text-caption text-gray-500">{label}</Text>
        </View>
      </View>
    );
  }

  const mine = row.side === "mine";
  const time = formatTimeOfDay(row.at, formatLocale());
  const gap = row.startsRun ? "mt-3" : "mt-1";
  const align = mine ? "items-end pl-12 pr-2" : "items-start pl-2 pr-12";

  if (row.pending) {
    const { pending } = row;
    const failed = pending.state === "failed" && !closed;
    const sending = pending.state === "sending";
    const bubble = (
      <>
        <ChatBubble side="mine" tail faded={sending}>
          <Text className="text-body text-white">{pending.body}</Text>
          {sending ? (
            <View className={STAMP}>
              <ReceiptTicks state="sending" testID="chat-receipt" />
            </View>
          ) : null}
        </ChatBubble>
        {sending ? null : (
          <Text className={META_DANGER} testID="chat-pending-status">
            {failed ? t("chat.bubble.failed") : t("chat.bubble.refused")}
          </Text>
        )}
      </>
    );
    // Spoken as "You, not sent: <text>"; a failed bubble's hint says a tap sends it again.
    const label = t("chat.bubble.pendingLabel", {
      text: pending.body,
      state:
        pending.state === "sending" ? t("chat.bubble.stateSending") : t("chat.bubble.stateNotSent"),
    });
    return failed ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("chat.bubble.retryHint")}
        onPress={() => onRetry(pending.localId)}
        className={`${gap} ${align}`}
        testID={`chat-pending-${pending.localId}`}
      >
        {bubble}
      </Pressable>
    ) : (
      <View
        accessible
        accessibilityLabel={label}
        className={`${gap} ${align}`}
        testID={`chat-pending-${pending.localId}`}
      >
        {bubble}
      </View>
    );
  }

  const { message } = row;
  const sender = mine ? t("chat.you") : peerName;
  const note = mine && message.redacted ? t("chat.redacted") : null;
  const receipt = mine ? receiptOf(message) : null;
  const label = [
    t("chat.bubble.label", { sender, time, text: message.body }),
    receipt ? t(`chat.receipt.${receipt}`) : null,
    note,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <View
      accessible
      accessibilityLabel={label}
      className={`${gap} ${align}`}
      testID={`chat-message-${message.id}`}
    >
      <ChatBubble side={row.side} tail={row.endsRun}>
        <Text className={mine ? "text-body text-white" : "text-body text-navy-900"}>
          {message.body}
        </Text>
        <View className={STAMP}>
          <Text className={mine ? TIME_ON_MINE : TIME_ON_THEIRS} testID="chat-time">
            {time}
          </Text>
          {receipt ? <ReceiptTicks state={receipt} testID="chat-receipt" /> : null}
        </View>
      </ChatBubble>
      {note ? (
        <Text className={`${META} text-right`} testID="chat-redacted-note">
          {note}
        </Text>
      ) : null}
    </View>
  );
});
