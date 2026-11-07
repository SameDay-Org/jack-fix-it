// Dev-only sample for the gallery (src/app/dev/components.tsx); the strings are literal on purpose.
import { Text, View } from "react-native";

import { ChatBubble, ReceiptTicks, type ReceiptState } from "@/components/ui";

const MINE: { state: ReceiptState; text: string }[] = [
  { state: "sending", text: "On its way" },
  { state: "sent", text: "Stored by the server" },
  { state: "delivered", text: "Fetched by their app" },
  { state: "seen", text: "Read by them" },
];

/**
 * The chat bubbles (#74): theirs in white with the time, then mine in navy with each receipt state
 * (a clock while sending, one tick, two ticks, two light-blue ticks), the tail on the last of a run.
 */
export function ChatBubbleSample() {
  return (
    <View className="gap-1 rounded-lg bg-gray-50 p-3">
      <View className="items-start pr-12">
        <ChatBubble side="theirs" tail>
          <Text className="text-body text-navy-900">Is the leak under the kitchen sink?</Text>
          <View className="mt-0.5 flex-row items-center justify-end gap-1 self-end">
            <Text className="text-caption text-gray-500">9:41 AM</Text>
          </View>
        </ChatBubble>
      </View>
      {MINE.map(({ state, text }, index) => (
        <View key={state} className="mt-1 items-end pl-12">
          <ChatBubble side="mine" tail={index === MINE.length - 1} faded={state === "sending"}>
            <Text className="text-body text-white">{text}</Text>
            <View className="mt-0.5 flex-row items-center justify-end gap-1 self-end">
              {state === "sending" ? null : (
                <Text className="text-caption text-white/70">9:42 AM</Text>
              )}
              <ReceiptTicks state={state} />
            </View>
          </ChatBubble>
        </View>
      ))}
    </View>
  );
}
