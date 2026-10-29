import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type TextLayoutEvent } from "react-native";

import { Button } from "@/components/ui";
import { continuousCorners } from "@/theme";

/** Lines of the scope, or of the pro's approach, a card shows before its toggle. */
export const SCOPE_LINES = 4;

const HIDDEN = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

type ToggleLabels = { more: string; less: string; moreLabel: string; lessLabel: string };

type ClampedNoteProps = {
  title: string;
  text: string;
  toggle: ToggleLabels;
  /** True when the card's summary label already says the text: screen readers skip it here. */
  visualOnly?: boolean;
  testID: string;
};

/**
 * A titled text in an inset bubble: up to four lines, with a toggle when the text is longer. An
 * invisible copy without the line limit, laid over the visible text at its exact width, counts
 * the lines the whole text takes; it never takes space or touches.
 */
function ClampedNote({ title, text, toggle, visualOnly = false, testID }: ClampedNoteProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = (event: TextLayoutEvent) =>
    setOverflows(event.nativeEvent.lines.length > SCOPE_LINES);

  return (
    <View className="gap-1">
      <View
        {...(visualOnly ? HIDDEN : null)}
        style={continuousCorners}
        className="gap-1 rounded-md bg-gray-50 p-3"
      >
        <Text className="text-caption text-gray-500">{title}</Text>
        {/* Clipped: the full-length copy may run past the visible lines. */}
        <View className="overflow-hidden">
          <Text
            numberOfLines={expanded ? 0 : SCOPE_LINES}
            className="text-callout text-navy-900"
            testID={testID}
          >
            {text}
          </Text>
          <View
            pointerEvents="none"
            {...HIDDEN}
            className="absolute left-0 right-0 top-0 opacity-0"
          >
            <Text onTextLayout={measure} className="text-callout" testID={`${testID}-measure`}>
              {text}
            </Text>
          </View>
        </View>
      </View>
      {overflows ? (
        // Pulled back by the card's padding: the pressed pill stays inside the bubble.
        <Button
          label={expanded ? toggle.less : toggle.more}
          accessibilityLabel={expanded ? toggle.lessLabel : toggle.moreLabel}
          variant="ghost"
          onPress={() => setExpanded((open) => !open)}
          className="-ml-4 self-start"
          testID={`${testID}-toggle`}
        />
      ) : null}
    </View>
  );
}

/** What the quote includes, as the API sent it (contact details already masked), with "More". */
export function ScopeText({ scope, testID }: { scope: string; testID: string }) {
  const { t } = useTranslation();
  const toggle = {
    more: t("quotes.more"),
    less: t("quotes.less"),
    moreLabel: t("quotes.moreLabel"),
    lessLabel: t("quotes.lessLabel"),
  };
  return <ClampedNote title={t("quotes.included")} text={scope} toggle={toggle} testID={testID} />;
}

/**
 * How the pro will do the job (masked like the scope), with "Read more". The card's summary
 * label says it, so screen readers skip the text here; the toggle stays a control.
 */
export function ApproachText({ approach, testID }: { approach: string; testID: string }) {
  const { t } = useTranslation();
  const toggle = {
    more: t("quotes.approach.more"),
    less: t("quotes.approach.less"),
    moreLabel: t("quotes.approach.moreLabel"),
    lessLabel: t("quotes.approach.lessLabel"),
  };
  return (
    <ClampedNote
      title={t("quotes.approach.title")}
      text={approach}
      toggle={toggle}
      visualOnly
      testID={testID}
    />
  );
}
