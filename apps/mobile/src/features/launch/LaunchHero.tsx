import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { Button, Screen } from "@/components/ui";
import { WelcomeActions } from "@/features/auth/components/WelcomeActions";

import { BrandHero } from "./BrandHero";

type LaunchHeroProps = {
  /** The rolling word's element: a `WordRotator`, or a plain green word for the static frame. */
  word: ReactNode;
  /** Optional skip control, bottom right. */
  skip?: { label: string; onPress: () => void };
  /** Called once, when the hero's headline rows are laid out natively. */
  onLaidOut?: () => void;
  testID?: string;
};

const noop = () => undefined;

/**
 * The launch frame: Welcome's own composition, full-bleed navy with the brand hero above the
 * actions bubble, except that the bubble is invisible and the hero's word rolls. The bubble still
 * takes its space, so the sentence sits exactly where Welcome's does and the exit fades one
 * headline into the same headline. Skip, when present, floats over the frame.
 */
export function LaunchHero({ word, skip, onLaidOut, testID }: LaunchHeroProps) {
  const { bottom } = useSafeAreaInsets();
  const { cleanupPending } = useSession();

  return (
    <Screen bar="hero" edges={[]} testID={testID}>
      <View className="flex-1 bg-navy-900">
        <BrandHero word={word} onLaidOut={onLaidOut} testID={testID && `${testID}-headline`} />
        <WelcomeActions
          hidden
          cleanupPending={cleanupPending}
          onGetStarted={noop}
          onLogin={noop}
          testID={testID && `${testID}-actions`}
        />
        {skip ? (
          <View
            className="absolute right-0 px-4 pb-4"
            style={{ bottom }}
            testID={testID && `${testID}-skip-row`}
          >
            <Button
              label={skip.label}
              variant="hero"
              onPress={skip.onPress}
              testID={testID && `${testID}-skip`}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
