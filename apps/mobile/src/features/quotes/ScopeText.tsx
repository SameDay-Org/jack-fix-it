import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type TextLayoutEvent } from "react-native";

import { Button } from "@/components/ui";
import { continuousCorners } from "@/theme";

/** Lines of the scope a card shows before "More". */
export const SCOPE_LINES = 4;

type ScopeTextProps = {
  /** What the quote includes, as the API sent it (contact details already masked). */
  scope: string;
  testID: string;
};

/**
 * What the quote includes, in an inset bubble: up to four lines, with "More" when the text is
 * longer. An invisible copy without the line limit, laid over the visible text at its exact
 * width, counts the lines the whole scope takes; it never takes space or touches.
 */
export function ScopeText({ scope, testID }: ScopeTextProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = (event: TextLayoutEvent) =>
    setOverflows(event.nativeEvent.lines.length > SCOPE_LINES);

  return (
    <View className="gap-1">
      <View style={continuousCorners} className="gap-1 rounded-md bg-gray-50 p-3">
        <Text className="text-caption text-gray-500">{t("quotes.included")}</Text>
        {/* Clipped: the full-length copy may run past the visible lines. */}
        <View className="overflow-hidden">
          <Text
            numberOfLines={expanded ? 0 : SCOPE_LINES}
            className="text-callout text-navy-900"
            testID={testID}
          >
            {scope}
          </Text>
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute left-0 right-0 top-0 opacity-0"
          >
            <Text onTextLayout={measure} className="text-callout" testID={`${testID}-measure`}>
              {scope}
            </Text>
          </View>
        </View>
      </View>
      {overflows ? (
        // Pulled back by the card's padding: the pressed pill stays inside the bubble.
        <Button
          label={t(expanded ? "quotes.less" : "quotes.more")}
          accessibilityLabel={t(expanded ? "quotes.lessLabel" : "quotes.moreLabel")}
          variant="ghost"
          onPress={() => setExpanded((open) => !open)}
          className="-ml-4 self-start"
          testID={`${testID}-toggle`}
        />
      ) : null}
    </View>
  );
}
