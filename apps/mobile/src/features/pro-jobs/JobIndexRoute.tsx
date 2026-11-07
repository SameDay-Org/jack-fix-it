import type { NavigationProp, ParamListBase } from "expo-router/react-navigation";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { useSession } from "@/api";
import { jobHref } from "@/features/jobs/api";
import { isUuid } from "@/features/quotes/navigation";

import { ProJobScreen } from "./ProJobScreen";

/**
 * `/jobs/[id]`: the pro's job screen, for a pro. The job's stack anchors on this route, so a link
 * that launches the app on one of the job's other screens builds it underneath, whoever is signed
 * in; a customer must never get the pro's screen there (#323). Anyone else gets `NotYourScreen`.
 */
export function JobIndexRoute() {
  const { user } = useSession();
  return user?.role === "pro" ? <ProJobScreen /> : <NotYourScreen />;
}

type StackState = ReturnType<NavigationProp<ParamListBase>["getState"]>;

/** The request a screen of this job's stack was opened for (`?request=<uuid>`), if any. */
function linkedRequest(state: StackState): string | undefined {
  for (const route of state?.routes ?? []) {
    const params: unknown = route.params;
    const value =
      typeof params === "object" && params !== null && "request" in params
        ? params.request
        : undefined;
    if (isUuid(value)) return value;
  }
  return undefined;
}

/**
 * Holds the place of the pro's screen for anyone else: draws the job screen's page color, asks for
 * nothing, and is never shown for long. Once it is focused (opened directly, or uncovered by
 * Back) it hands over: to the customer's own job when the link named their request (`request`, a
 * UUID: the customer's job links carry it), Home otherwise. The anchor gets none of the link's
 * query, so the request is read from the screen the link opened over it, as this one mounts
 * (Back takes that screen away).
 */
function NotYourScreen() {
  const own = useLocalSearchParams<{ request?: string | string[] }>().request;
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const [request] = useState(() => (isUuid(own) ? own : linkedRequest(navigation.getState())));

  useFocusEffect(
    useCallback(() => {
      if (request !== undefined) router.replace(jobHref(request));
      else router.dismissTo("/");
    }, [request]),
  );

  return (
    <View
      className="flex-1 bg-gray-50"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="job-not-yours"
    />
  );
}
