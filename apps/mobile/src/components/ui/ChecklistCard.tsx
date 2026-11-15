import { Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { tokens } from "@/theme";

import { Button } from "./Button";
import { Card } from "./Card";
import { Skeleton } from "./Skeleton";
import { TextSkeleton } from "./TextSkeleton";

export type ChecklistStep = {
  /** Stable name of the step: its key and the end of its test id. */
  id: string;
  /** Already translated by the caller. */
  label: string;
  done: boolean;
  /** The step as a screen reader hears it: its name and whether it is done ("About you: to do"). */
  accessibilityLabel: string;
};

export type ChecklistCardProps = {
  title: string;
  /** How far along the list is, in words ("2 of 4 done"). */
  progress: string;
  steps: readonly ChecklistStep[];
  /** The card's one action: where the steps are done. */
  actionLabel: string;
  onAction: () => void;
  testID: string;
};

/** The step mark's side, on the 4-pt grid; the tick inside leaves a 4 dp margin. */
const MARK_SIDE = 24;
const TICK_SIDE = 16;

/**
 * A short list of things to finish, as a white bubble: its title, how far along it is, each step
 * with a green tick once done and an empty ring until then, and one button that leads to where
 * they are done. The marks keep their size at any font scale; the labels wrap.
 */
export function ChecklistCard({
  title,
  progress,
  steps,
  actionLabel,
  onAction,
  testID,
}: ChecklistCardProps) {
  return (
    <Card testID={testID}>
      <View className="gap-4">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {title}
          </Text>
          <Text className="text-callout text-gray-500" testID={`${testID}-progress`}>
            {progress}
          </Text>
        </View>
        <View className="gap-3">
          {steps.map((step) => (
            <View
              key={step.id}
              accessible
              accessibilityLabel={step.accessibilityLabel}
              className="flex-row items-center gap-3"
              testID={`${testID}-${step.id}`}
            >
              <View
                style={{ width: MARK_SIDE, height: MARK_SIDE }}
                className={
                  step.done
                    ? "items-center justify-center rounded-pill bg-success"
                    : "rounded-pill border-2 border-gray-500/40"
                }
              >
                {step.done ? (
                  <ControlIcon name="check" size={TICK_SIDE} color={tokens.colors.white} />
                ) : null}
              </View>
              <Text
                className={
                  step.done
                    ? "flex-1 text-callout text-gray-500"
                    : "flex-1 text-callout text-navy-900"
                }
              >
                {step.label}
              </Text>
            </View>
          ))}
        </View>
        <Button label={actionLabel} onPress={onAction} testID={`${testID}-action`} />
      </View>
    </Card>
  );
}

export type ChecklistCardSkeletonProps = {
  /** How many steps the card will list. */
  steps: number;
  testID?: string;
};

/** A card-shaped placeholder: the title and progress lines, then a mark and a line per step. */
export function ChecklistCardSkeleton({ steps, testID }: ChecklistCardSkeletonProps) {
  return (
    <Card testID={testID}>
      <View className="gap-4">
        <View className="gap-1">
          <TextSkeleton type="headline" width="60%" />
          <TextSkeleton type="callout" width="35%" />
        </View>
        <View className="gap-3">
          {Array.from({ length: steps }, (_, index) => (
            <View key={index} className="flex-row items-center gap-3">
              <Skeleton circle height={MARK_SIDE} />
              <TextSkeleton type="callout" width="50%" />
            </View>
          ))}
        </View>
      </View>
    </Card>
  );
}
