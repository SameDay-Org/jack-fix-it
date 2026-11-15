import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";
import { Pressable, View, type AccessibilityActionEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
} from "react-native-reanimated";

import { ControlIcon } from "@/components/icons";
import { tokens, withOpacity } from "@/theme";

/** The API's scale (`ReviewIn`): 1 (worst) to 5 (best). */
export type StarScore = 1 | 2 | 3 | 4 | 5;
export const STAR_SCORES: readonly StarScore[] = [1, 2, 3, 4, 5];
const STAR_COUNT = STAR_SCORES.length;

/** Glyph and touch target, in dp: never below 48 (Android) to touch, never following the font. */
const SIZE = {
  lg: { glyph: 40, target: 56 },
  md: { glyph: 28, target: 48 },
} as const;
export type StarRatingSize = keyof typeof SIZE;

// A given star: lime inside a green-700 edge, which keeps 3:1 against white. An empty one: a navy
// outline at half strength (3.5:1 on white).
const GIVEN_EDGE = tokens.colors["green-700"];
const GIVEN_FILL = tokens.colors["green-500"];
const EMPTY_EDGE = withOpacity("navy-900", 0.5);
/** The chosen star swells this much and springs back; never under Reduce Motion. */
const POP_SCALE = 1.18;
const POP_SPRING = { damping: 14, stiffness: 420 };

const isScore = (value: number): value is StarScore => value >= 1 && value <= STAR_COUNT;

export type StarRatingProps = {
  /** What is rated, said before the value: "Overall", "Communication". */
  label: string;
  value: StarScore | null;
  onChange: (value: StarScore | null) => void;
  size?: StarRatingSize;
  /** An optional rating: a tap on the given star, or stepping below one, takes it back. */
  clearable?: boolean;
  disabled?: boolean;
  testID?: string;
};

/**
 * One to five stars to tap. To assistive technology the row is one adjustable control ("Overall,
 * 3 of 5 stars"): swipe up or down to change it; the stars themselves are hidden from it. A tap
 * gives a selection tick, and the chosen star pops unless Reduce Motion is on.
 */
export function StarRating({
  label,
  value,
  onChange,
  size = "md",
  clearable = false,
  disabled = false,
  testID,
}: StarRatingProps) {
  const { t } = useTranslation();

  const choose = (next: StarScore | null) => {
    if (disabled || next === value) return;
    onChange(next);
    void Haptics.selectionAsync().catch(() => undefined);
  };
  const onTap = (score: StarScore) => choose(clearable && score === value ? null : score);
  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    const step = nativeEvent.actionName === "increment" ? 1 : -1;
    const next = (value ?? 0) + step;
    if (isScore(next)) choose(next);
    else if (next < 1 && clearable) choose(null);
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: STAR_COUNT,
        now: value ?? 0,
        text: value
          ? t("common.stars.value", { count: value, max: STAR_COUNT })
          : t("common.stars.none"),
      }}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAccessibilityAction}
      className="flex-row"
      testID={testID}
    >
      {STAR_SCORES.map((score) => (
        <Star
          key={score}
          given={value !== null && score <= value}
          size={size}
          disabled={disabled}
          onPress={() => onTap(score)}
          testID={testID && `${testID}-${score}`}
        />
      ))}
    </View>
  );
}

type StarProps = {
  given: boolean;
  size: StarRatingSize;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
};

function Star({ given, size, disabled, onPress, testID }: StarProps) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const { glyph, target } = SIZE[size];

  const press = () => {
    if (!reduceMotion && !disabled) {
      scale.set(withSequence(withSpring(POP_SCALE, POP_SPRING), withSpring(1, POP_SPRING)));
    }
    onPress();
  };

  return (
    // The row speaks for the stars: each one is out of reach of assistive technology (Android needs
    // all three props), and stays a plain touch target.
    <Pressable
      accessible={false}
      focusable={false}
      importantForAccessibility="no"
      accessibilityElementsHidden
      disabled={disabled}
      onPress={press}
      className="items-center justify-center"
      style={{ width: target, height: target }}
      testID={testID}
    >
      <Animated.View style={style}>
        <ControlIcon
          name="star"
          size={glyph}
          color={given ? GIVEN_EDGE : EMPTY_EDGE}
          filled={given}
          fillColor={GIVEN_FILL}
        />
      </Animated.View>
    </Pressable>
  );
}

/** Stars only to look at, in a row ("you rated 4 stars"): the caller's text says the value. */
export function StarsShown({ value, glyph = 20 }: { value: number; glyph?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row gap-0.5"
    >
      {STAR_SCORES.map((score) => (
        <ControlIcon
          key={score}
          name="star"
          size={glyph}
          color={score <= value ? GIVEN_EDGE : EMPTY_EDGE}
          filled={score <= value}
          fillColor={GIVEN_FILL}
        />
      ))}
    </View>
  );
}
