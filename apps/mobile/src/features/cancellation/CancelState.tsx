import { useEffect, type ComponentProps, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";

import { TextSkeleton } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { BackButton } from "@/features/auth/components/BackButton";

/** Where the screen's Back goes when it was opened with nothing under it: the job. */
type JobBack = ComponentProps<typeof BackButton>["fallbackHref"];
/** The reasons each side's form lists (four on both), as the loading rows. */
const REASON_ROWS = 4;

export function CancelHeader({ title, intro }: { title: string; intro: string }) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-title-1 text-navy-900">
        {title}
      </Text>
      {intro ? <Text className="text-body text-gray-500">{intro}</Text> : null}
    </View>
  );
}

type CancelStateProps = {
  back: JobBack;
  title: string;
  body: string;
  children: ReactNode;
  /** Said aloud when it shows: it can take the place of the form the reader was in. */
  announced?: boolean;
  testID: string;
};

/** A state of a whole cancel screen: what happened, then what can be done. */
export function CancelState({
  back,
  title,
  body,
  children,
  announced = false,
  testID,
}: CancelStateProps) {
  useEffect(() => {
    if (announced) announce(`${title}. ${body}`);
  }, [announced, title, body]);
  return (
    <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2" testID={testID}>
      <BackButton fallbackHref={back} />
      <CancelHeader title={title} intro={body} />
      <View className="gap-4">{children}</View>
    </ScrollView>
  );
}

export function CancelSkeleton({ back }: { back: JobBack }) {
  return (
    <View className="gap-6 px-4 pt-2" testID="cancel-loading">
      <BackButton fallbackHref={back} />
      <TextSkeleton type="title-1" width="60%" />
      <TextSkeleton type="body" sample="Tell us why, and check what it costs." />
      {Array.from({ length: REASON_ROWS }, (_, row) => (
        <TextSkeleton key={row} type="headline" width="70%" />
      ))}
    </View>
  );
}
