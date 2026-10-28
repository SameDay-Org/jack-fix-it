import { Stack, useNavigationContainerRef } from "expo-router";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";

import { useSession } from "@/api";
// The deep path, not the barrel: the launch shell imports this feature, and the barrel would close
// a require cycle (launch -> auth -> launch) that Metro warns about.
import { LaunchHero } from "@/features/launch/LaunchHero";
import { tokens } from "@/theme";

import { OfflineScreen } from "./OfflineScreen";

/**
 * The one place that turns the session status into what the app shows. While the session is
 * `restoring` it shows the static launch frame, the same navy hero the intro draws over it, so a
 * slow restore never shows a blank. A restore that could not reach the server shows the offline
 * screen instead of asking for a login the device may not need. Signed in goes to `(app)`,
 * everyone else to `(auth)`, deep links included: a protected group redirects to the other
 * group's entry. A sign-in or a sign-out switches groups in one commit (see `GroupStack`).
 */
export function SessionGate() {
  const { t } = useTranslation();
  const { status, restoreFailure } = useSession();

  if (status === "restoring") {
    return (
      <LaunchHero
        testID="restoring-hero"
        word={
          <Text className="text-display text-green-500">
            {t("launch.words", { returnObjects: true })[0]}
          </Text>
        }
      />
    );
  }
  if (restoreFailure === "offline") return <OfflineScreen />;

  return <GroupStack group={status === "signedIn" ? "(app)" : "(auth)"} />;
}

type Group = "(app)" | "(auth)";

type ContainerRef = ReturnType<typeof useNavigationContainerRef>;

/**
 * The group the gate's stack has focused: the root slot's focused route holds that stack. None
 * while the router mounts with the gate: the container sets its ref after the gate's first layout
 * effect.
 */
function focusedGroup(navigation: ContainerRef): Group | undefined {
  if (!navigation.isReady()) return undefined;
  const root = navigation.getRootState();
  const stack = root?.routes[root.index]?.state;
  const name = stack?.routes[stack.index ?? stack.routes.length - 1]?.name;
  return name === "(app)" || name === "(auth)" ? name : undefined;
}

/**
 * The two protected groups, with `group` the one the session belongs in. A guard alone would
 * switch them in two steps: the group on screen turns into a redirect that renders nothing, and
 * the router replaces it a few renders later, so a sign-out showed plain navy for a second
 * before Welcome (#177). Instead the guards follow `shown`, and when the session changes groups
 * a layout effect replaces the group and moves the guards together: React commits that before
 * the frame is drawn, so the group that leaves stays on screen until the one that arrives is
 * built. The group that leaves renders once more with the new session meanwhile; that render is
 * never drawn, and its screens render nothing without a user. A stack mounted while the router
 * has the other group focused (after the offline screen, or a cold start signed out on the
 * launch URL) guards from the session at once, as before, and is replaced the same way.
 */
function GroupStack({ group }: { group: Group }) {
  const navigation = useNavigationContainerRef();
  const [shown, setShown] = useState(group);
  // The group of the last replace. Right after it the container can still report the group that
  // left (its state read refreshes in an effect that runs after this one under Jest), and a second
  // replace would build the new group's screen again.
  const replaced = useRef<Group | undefined>(undefined);

  useLayoutEffect(() => {
    if (shown === group) {
      // The guards already match the session: only a stack mounted over the other group's focus
      // needs the replace, once.
      if (replaced.current === group) return;
      const focused = focusedGroup(navigation);
      if (focused === undefined || focused === group) return;
    }
    // Synchronous: `dispatch` queues the action for a later render, as the redirect does.
    navigation.dispatchSync({ type: "REPLACE", payload: { name: group } });
    replaced.current = group;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the guards must change in the same commit as the navigation state dispatched above; an update from a layout effect is committed before paint.
    setShown(group);
  }, [group, navigation, shown]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // The frame under a group while its first screen mounts: navy, like the splash and the
        // intro over it, so a quick handoff (Reduce Motion, a fast restore) never shows white.
        contentStyle: { backgroundColor: tokens.colors["navy-900"] },
      }}
    >
      <Stack.Protected guard={shown === "(app)"} redirectTo="/(auth)/welcome">
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={shown === "(auth)"} redirectTo="/">
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
