import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui";
import { continuousCorners, tokens } from "@/theme";

import { MESSAGE_COUNTER_FROM, MESSAGE_MAX_LENGTH } from "./config";
import { textLength } from "./thread";
import type { SendNotice } from "./useSendQueue";

// The field grows with the text up to this many lines of the body style, then scrolls.
const MAX_LINES = 5;
const BODY_LINE = 24;
const FIELD_PADDING = 24;
// The bar's own breathing room under the field, above the home indicator or the keyboard.
const BAR_BOTTOM = 8;

/**
 * Whether the keyboard is up. iOS says so before it moves (the screen's avoiding view animates
 * with it); Android once it is up.
 */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () =>
      setShown(true),
    );
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setShown(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/** The bottom bar's padding: over the home indicator, or right on the keyboard while it is up. */
function useBarBottom(): number {
  const { bottom } = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  return (keyboard ? 0 : bottom) + BAR_BOTTOM;
}

export type ComposerProps = {
  /** Who the message goes to, inside a sentence ("Dan", "your pro"): the field's placeholder. */
  name: string;
  /** A message is on its way: the send button waits for it. */
  sending: boolean;
  notice: SendNotice;
  onSend: (body: string) => void;
};

/**
 * The bar at the bottom of the chat: a growing field and the round send button, which takes the
 * text only when it holds something and fits the API's limit (counted as the API counts it, in
 * characters). Near the limit a counter says how many are left, or how many are over. A send
 * clears the field and keeps the keyboard up for the next message.
 */
export function Composer({ name, sending, notice, onSend }: ComposerProps) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const [text, setText] = useState("");
  const paddingBottom = useBarBottom();
  const length = textLength(text);
  const left = MESSAGE_MAX_LENGTH - length;
  const canSend = length > 0 && left >= 0 && !sending;
  const counter =
    left < 0
      ? t("chat.composer.over", { count: -left })
      : left <= MESSAGE_COUNTER_FROM
        ? t("chat.composer.left", { count: left })
        : null;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  };

  return (
    <View className="gap-2 bg-white px-3 pt-2" style={{ paddingBottom }} testID="chat-composer">
      {notice === "tooFast" ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-2 text-footnote text-danger"
          testID="chat-too-fast"
        >
          {t("chat.tooFast")}
        </Text>
      ) : null}
      <View className="flex-row items-end gap-2">
        <View
          className="min-h-12 flex-1 justify-center rounded-lg bg-gray-50 px-4"
          style={continuousCorners}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={t("chat.composer.placeholder", { name })}
            placeholderTextColor={tokens.colors["gray-500"]}
            accessibilityLabel={t("chat.composer.label")}
            accessibilityHint={counter ?? undefined}
            className="py-3 text-body text-navy-900"
            style={{ maxHeight: BODY_LINE * fontScale * MAX_LINES + FIELD_PADDING }}
            testID="chat-input"
          />
        </View>
        <Button
          glyph="send"
          label={t("chat.composer.send")}
          onPress={send}
          disabled={!canSend}
          testID="chat-send"
        />
      </View>
      {counter ? (
        <Text
          accessibilityLiveRegion="polite"
          className={`px-2 text-right text-footnote ${left < 0 ? "text-danger" : "text-gray-500"}`}
          testID="chat-counter"
        >
          {counter}
        </Text>
      ) : null}
    </View>
  );
}

/** In place of the composer once the chat is read-only: what happened, calmly. */
export function ClosedBar() {
  const { t } = useTranslation();
  const paddingBottom = useBarBottom();
  return (
    <View
      accessible
      className="gap-1 bg-white px-6 pt-4"
      style={{ paddingBottom: paddingBottom + BAR_BOTTOM }}
      testID="chat-closed"
    >
      <Text accessibilityRole="header" className="text-center text-headline text-navy-900">
        {t("chat.closed.title")}
      </Text>
      <Text className="text-center text-callout text-gray-500">{t("chat.closed.body")}</Text>
    </View>
  );
}
