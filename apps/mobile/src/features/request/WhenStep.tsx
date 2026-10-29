import { router } from "expo-router";
import { useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { Button, ChoiceCard, Notice, useFlag } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { bubbleShadow, continuousCorners, pressedTransform } from "@/theme";

import { requestConfig } from "./config";
import { addDays, dayParts, formatLongDay, isPastDay, localToday, offeredDays } from "./dates";
import { setPreferredDate, useRequestDraft } from "./requestDraft";
import { StepScreen } from "./StepScreen";
import { nextStep, stepHref, type StepId } from "./steps";

/**
 * When the customer would like the job done: "I'm flexible" (no date, the default) or a day from a
 * strip of the next `EXPO_PUBLIC_REQUEST_DATE_DAYS` days, today (as the API counts it) first. The
 * chosen day is spelled out under the strip in the app's language. The preferred period (morning,
 * afternoon...) will go under it once the API takes one (#237).
 */
export function WhenStep({ steps }: { steps: readonly StepId[] }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const date = useRequestDraft((draft) => draft.preferredDate);
  const refused = useRequestDraft((draft) => draft.refusal?.reason === "staleDate");
  const stale = date !== null && isPastDay(date);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const reduceMotion = useReducedMotion();
  // A pick spells the day out at the bottom of the step, below the fold on a small phone: once it
  // is laid out, the step scrolls to it, above Continue.
  const reveal = useRef(false);
  const pick = (day: string) => {
    reveal.current = true;
    setPreferredDate(day);
  };

  const onContinue = () => {
    if (stale) {
      AccessibilityInfo.announceForAccessibility(t("request.when.staleTitle"));
      return;
    }
    const next = nextStep("when", steps);
    if (next) router.push(stepHref(next, steps));
  };

  return (
    <StepScreen
      step="when"
      steps={steps}
      title={t("request.when.title")}
      support={t("request.when.support")}
      action={
        <Button
          label={t("common.continue")}
          size="lg"
          onPress={onContinue}
          testID="when-continue"
        />
      }
      refusal={refused ? t("request.when.staleTitle") : undefined}
      scrollRef={scrollRef}
      testID="request-when"
    >
      {refused || stale ? (
        <Notice
          tone="danger"
          title={t("request.when.staleTitle")}
          body={t("request.when.staleBody")}
          testID="when-stale"
        />
      ) : null}
      <ChoiceCard
        title={t("request.when.flexible")}
        description={t("request.when.flexibleHint")}
        selected={date === null}
        onPress={() => setPreferredDate(null)}
        testID="when-flexible"
      />
      <View className="gap-3">
        <Text className="text-headline text-navy-900">{t("request.when.pickDay")}</Text>
        <DayStrip selected={stale ? null : date} locale={locale} onPick={pick} />
        {date !== null && !stale ? (
          <Text
            // A new line for each day, so each pick lays it out again.
            key={date}
            className="text-title-2 text-navy-900"
            onLayout={() => {
              if (!reveal.current) return;
              reveal.current = false;
              scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
            }}
            testID="when-chosen"
          >
            {formatLongDay(date, locale)}
          </Text>
        ) : null}
      </View>
    </StepScreen>
  );
}

type DayStripProps = { selected: string | null; locale: string; onPick: (day: string) => void };

/** The offered days as a row of bubbles that scrolls sideways, the chosen one filled navy. */
function DayStrip({ selected, locale, onPick }: DayStripProps) {
  const { t } = useTranslation();
  // Every render: the step stays mounted under Review, and a send refused after midnight comes
  // back to a strip that must start at the new first day (it is a few dozen strings).
  const days = offeredDays(requestConfig.dateDays);
  const today = localToday();
  const tomorrow = addDays(today, 1);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrolled = useRef(false);

  const relative = (day: string) =>
    day === today ? t("request.when.today") : day === tomorrow ? t("request.when.tomorrow") : null;

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel={t("request.when.pickDay")}
      // The bubbles' shadow needs room inside the scroll view, and the row runs to the screen's
      // edges while its first bubble lines up with the page's content.
      className="-mx-4"
      contentContainerClassName="gap-2 px-4 py-2"
      testID="when-days"
    >
      {days.map((day) => (
        <DayBubble
          key={day}
          day={day}
          locale={locale}
          relative={relative(day)}
          selected={day === selected}
          onPress={() => onPick(day)}
          onLayout={(x) => {
            // Back on the step with a day chosen: it is in view, once.
            if (day !== selected || scrolled.current) return;
            scrolled.current = true;
            scrollRef.current?.scrollTo({ x, animated: false });
          }}
        />
      ))}
    </ScrollView>
  );
}

type DayBubbleProps = {
  day: string;
  locale: string;
  /** "Today" or "Tomorrow" on the phone's calendar, in place of the weekday. */
  relative: string | null;
  selected: boolean;
  onPress: () => void;
  onLayout: (x: number) => void;
};

function DayBubble({ day, locale, relative, selected, onPress, onLayout }: DayBubbleProps) {
  const [pressed, pressIn, pressOut] = useFlag();
  const parts = dayParts(day, locale);
  const long = formatLongDay(day, locale);

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={relative ? `${relative}, ${long}` : long}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      onLayout={({ nativeEvent }) => onLayout(nativeEvent.layout.x)}
      style={
        pressed
          ? [bubbleShadow, continuousCorners, pressedTransform]
          : [bubbleShadow, continuousCorners]
      }
      className={cx(
        // One width for every day at the default size; a longer label ("Tomorrow") grows its own.
        "min-w-20 items-center gap-0.5 rounded-lg px-2 py-3",
        selected ? "bg-navy-900" : "bg-white",
      )}
      testID={`when-day-${day}`}
    >
      <Text
        numberOfLines={1}
        className={cx("text-footnote font-semibold", selected ? "text-green-500" : "text-gray-500")}
      >
        {relative ?? parts.weekday}
      </Text>
      <Text className={cx("text-title-2", selected ? "text-white" : "text-navy-900")}>
        {parts.date}
      </Text>
      <Text className={cx("text-caption", selected ? "text-white" : "text-gray-500")}>
        {parts.month}
      </Text>
    </Pressable>
  );
}
