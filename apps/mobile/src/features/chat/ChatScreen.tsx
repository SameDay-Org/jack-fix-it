import { router, useLocalSearchParams } from "expo-router";
import type { TFunction } from "i18next";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError } from "@/api";
import { Avatar, Button, Screen, Skeleton } from "@/components/ui";
import { backToPrevious } from "@/features/auth/components/BackButton";
import { isUuid } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { useChat, useOlderMessages, type OlderState } from "./api";
import { ClosedBar, Composer } from "./Composer";
import { MessageRow } from "./MessageRow";
import { useChatPeer, type ChatPeer } from "./peer";
import { threadRows, type Row } from "./thread";
import { useReadMarker } from "./useReadMarker";
import { useSendQueue, type SendOutcome } from "./useSendQueue";

/** No chat for this caller and id: not a participant, or no such job (404, as for anyone else's). */
const isGone = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

// The list keeps what is on screen in place when a message lands below it, unless the reader is
// this close to the newest one: then it follows down to it.
const FOLLOW_NEWEST_WITHIN = 48;
const MAINTAIN_POSITION = { minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_NEWEST_WITHIN };

/**
 * The chat of one job (`/jobs/[id]/chat`, #74), the same screen for both sides: a navy top bar with
 * the way back, the other side's initials and first name; the conversation in bubbles (mine on the
 * right in navy, theirs on the left in white), newest at the bottom, with day headings and the time
 * under each run; older messages through the cursor; and the composer, or, once the job is closed,
 * a calm word that the chat is read-only. The chat asks for new messages while it is open
 * (`useChat`) and marks them read (`useReadMarker`). A customer's link carries the request too
 * (`request`), from which the pro's name and the job's state are read.
 */
export function ChatScreen() {
  const { t } = useTranslation();
  const { id, request } = useLocalSearchParams<{ id: string; request?: string }>();
  const valid = isUuid(id);
  const peer = useChatPeer(id, request);
  const {
    data: thread,
    error,
    refetch,
    isFetching,
    dataUpdatedAt,
    generation,
  } = useChat(id, { enabled: valid });
  const shownError = useSettledError(thread, error);
  const older = useOlderMessages(id, generation);
  const [closedBySend, setClosedBySend] = useState(false);
  const closed = peer.closed || closedBySend;
  const list = useRef<FlatList<Row>>(null);

  const onDone = useCallback(
    (outcome: Exclude<SendOutcome, "void">) => {
      AccessibilityInfo.announceForAccessibility(
        outcome === "sent" ? t("chat.announce.sent") : t("chat.announce.failed"),
      );
    },
    [t],
  );
  const queue = useSendQueue(id, generation, {
    onClosed: () => setClosedBySend(true),
    onDone,
  });
  useReadMarker(id, generation, thread, peer.onUnread);

  const names = peerNames(t, peer);
  const rows = useMemo(
    () => (thread ? threadRows(thread.messages, queue.pending) : []),
    [queue.pending, thread],
  );
  const sending = queue.pending.some((item) => item.state === "sending");

  const send = (body: string) => {
    queue.send(body);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };

  let body;
  if (!valid || isGone(shownError)) {
    body = (
      <ChatState
        title={t("chat.notFound.title")}
        body={t("chat.notFound.body")}
        action={t("chat.notFound.home")}
        onAction={() => router.dismissTo("/")}
        testID="chat-not-found"
      />
    );
  } else if (thread) {
    body =
      rows.length === 0 ? (
        <EmptyChat name={peer.fullName ?? names.lead} inline={names.inline} />
      ) : (
        <FlatList
          ref={list}
          inverted
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => (
            <MessageRow
              row={item}
              peerName={names.lead}
              now={dataUpdatedAt}
              onRetry={queue.retry}
            />
          )}
          onEndReached={() => void older.load()}
          onEndReachedThreshold={0.5}
          maintainVisibleContentPosition={MAINTAIN_POSITION}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerClassName="px-4 py-4"
          ListFooterComponent={
            <ThreadStart
              more={thread.olderCursor !== null}
              state={older.state}
              onLoad={older.load}
            />
          }
          testID="chat-list"
        />
      );
  } else if (shownError) {
    body = (
      <ChatState
        title={t("chat.error.title")}
        body={t("chat.error.body")}
        action={t("chat.error.retry")}
        onAction={() => void refetch()}
        busy={isFetching}
        testID="chat-error"
      />
    );
  } else {
    body = <ChatSkeleton />;
  }

  return (
    <Screen bar="hero" edges={[]} testID="chat-screen">
      {/* Light under the bar too, so its rounded bottom corners round onto the conversation. */}
      <View className="flex-1 bg-gray-50">
        <ChatTopBar peer={peer} name={names.lead} role={names.role} />
        <ChatKeyboardView>
          <View className="flex-1">{body}</View>
          {thread && valid ? (
            closed ? (
              <ClosedBar />
            ) : (
              <Composer name={names.inline} sending={sending} notice={queue.notice} onSend={send} />
            )
          ) : null}
        </ChatKeyboardView>
      </View>
    </Screen>
  );
}

/**
 * Lifts the list and the composer over the keyboard. Padding on both platforms (the app draws edge
 * to edge on Android); the offset adds back the status bar `Screen` starts the content below.
 */
function ChatKeyboardView({ children }: { children: ReactNode }) {
  const { top } = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={top}
      className="flex-1"
      testID="chat-keyboard"
    >
      {children}
    </KeyboardAvoidingView>
  );
}

type PeerNames = { lead: string; inline: string; role: string };

/** The other side as a sentence starts with them, inside one, and what they are on this job. */
function peerNames(t: TFunction, peer: ChatPeer): PeerNames {
  if (peer.role === "pro") {
    return {
      lead: peer.firstName ?? t("chat.peer.pro.fallback"),
      inline: peer.firstName ?? t("chat.peer.pro.inline"),
      role: t("chat.peer.pro.role"),
    };
  }
  return {
    lead: peer.firstName ?? t("chat.peer.customer.fallback"),
    inline: peer.firstName ?? t("chat.peer.customer.inline"),
    role: t("chat.peer.customer.role"),
  };
}

const AVATAR_SIZE = 48;
const NAME_WIDTH = "45%";

/** The navy bar: the way back, then who the chat is with (a placeholder until the job answers). */
function ChatTopBar({ peer, name, role }: { peer: ChatPeer; name: string; role: string }) {
  const { t } = useTranslation();
  return (
    <View
      className="z-10 flex-row items-center gap-3 rounded-b-xl bg-navy-900 px-4 pb-4 pt-2"
      testID="chat-top-bar"
    >
      <Button
        glyph="back"
        variant="hero"
        label={t("common.back")}
        onPress={() => backToPrevious("/")}
        testID="chat-back"
      />
      {peer.known ? (
        <>
          <Avatar name={peer.fullName ?? name} size="md" />
          <View className="flex-1">
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              className="text-headline text-white"
              testID="chat-peer-name"
            >
              {name}
            </Text>
            <Text numberOfLines={2} className="text-footnote text-white">
              {role}
            </Text>
          </View>
        </>
      ) : (
        <View
          className="flex-1 flex-row items-center gap-3"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="chat-peer-loading"
        >
          <View
            className="rounded-pill bg-white/15"
            style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
          />
          <View className="h-4 rounded-pill bg-white/15" style={{ width: NAME_WIDTH }} />
        </View>
      )}
    </View>
  );
}

/**
 * The top of the conversation (the list's footer, the list being upside down): the way to older
 * messages while there are some, else where the conversation starts.
 */
function ThreadStart({
  more,
  state,
  onLoad,
}: {
  more: boolean;
  state: OlderState;
  onLoad: () => Promise<void>;
}) {
  const { t } = useTranslation();
  if (!more) {
    return (
      <Text className="px-6 pb-2 pt-4 text-center text-footnote text-gray-500">
        {t("chat.start")}
      </Text>
    );
  }
  if (state === "loading") {
    return (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("chat.loading")}
        className="min-h-12 items-center justify-center"
        testID="chat-older-loading"
      >
        <ActivityIndicator color={tokens.colors["navy-900"]} />
      </View>
    );
  }
  return (
    <View className="items-center gap-1 pb-2" testID="chat-older">
      {state === "failed" ? (
        <Text accessibilityLiveRegion="polite" className="text-footnote text-danger">
          {t("chat.older.failed")}
        </Text>
      ) : null}
      <Button
        variant="ghost"
        label={state === "failed" ? t("chat.older.retry") : t("chat.older.load")}
        onPress={() => void onLoad()}
        testID="chat-older-load"
      />
    </View>
  );
}

/** No message yet: who to say hello to and what the chat is for. */
function EmptyChat({ name, inline }: { name: string; inline: string }) {
  const { t } = useTranslation();
  return (
    // Scrolls when the keyboard leaves it less room than it needs, rather than clipping its top.
    <ScrollView
      className="flex-1"
      contentContainerClassName="flex-grow items-center justify-center gap-3 px-8 py-6"
      keyboardShouldPersistTaps="handled"
      testID="chat-empty"
    >
      <Avatar name={name} size="lg" />
      <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
        {t("chat.empty.title", { name: inline })}
      </Text>
      <Text className="text-center text-callout text-gray-500">{t("chat.empty.body")}</Text>
    </ScrollView>
  );
}

type ChatStateProps = {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  busy?: boolean;
  testID: string;
};

/** A state of the whole conversation area: what happened, then what to do next. */
function ChatState({ title, body, action, onAction, busy, testID }: ChatStateProps) {
  return (
    <View className="flex-1 justify-center gap-6 px-8" testID={testID}>
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
          {title}
        </Text>
        <Text className="text-center text-callout text-gray-500">{body}</Text>
      </View>
      <Button
        label={action}
        onPress={onAction}
        loading={busy}
        size="lg"
        testID={`${testID}-action`}
      />
    </View>
  );
}

// The skeleton's bubbles: alternating sides and widths, as a short conversation would sit.
const SKELETON_BUBBLES = [
  { side: "theirs", width: "62%" },
  { side: "mine", width: "48%" },
  { side: "theirs", width: "70%" },
  { side: "mine", width: "40%" },
] as const;
const SKELETON_BUBBLE_HEIGHT = 44;

/** Bubble shapes where the conversation will be: nothing jumps when it arrives. */
function ChatSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("chat.loading")}
      className="flex-1 justify-end gap-3 px-4 py-4"
      testID="chat-loading"
    >
      {SKELETON_BUBBLES.map(({ side, width }, index) => (
        <View key={index} className={side === "mine" ? "items-end" : "items-start"}>
          <View style={{ width }}>
            <Skeleton height={SKELETON_BUBBLE_HEIGHT} radius="lg" />
          </View>
        </View>
      ))}
    </View>
  );
}
