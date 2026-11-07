import { useFocusEffect } from "expo-router";
import { Tabs, type BottomTabBarProps } from "expo-router/js-tabs";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useDerivedValue } from "react-native-reanimated";

import { TabBar, TabBarAccessoryContext, type TabBarItem } from "@/components/ui";
import { CONTENT_FROM, usePanelHandoff, usePanelHandoffContext } from "@/features/auth";
import { JobBanner, useActiveJob } from "@/features/jobs";
import { tokens } from "@/theme";

import { TABS, tabFor } from "./tabs";

/**
 * The navigator's state as the kit's bar: one item per tab route, in the navigator's order. A
 * press emits `tabPress` first (a focused tab's scroll view listens for it and scrolls to the top),
 * then moves to the tab unless a listener prevented it, as the default bar does.
 */
function RouterTabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const { t } = useTranslation();
  // Home's categories panel rising into a request: the bar slides away over the first half of the
  // rise, as the panel's cards fade, and comes back as the panel lowers.
  // Only over Home: a panel left up under another tab (a link that opened it from outside) must
  // not take the bar with it.
  const { progress } = usePanelHandoffContext();
  const { phase } = usePanelHandoff();
  const onHome = tabFor(state.routes[state.index]?.name ?? "")?.route === "index";
  const { active, updatedAt, refetch } = useActiveJob();
  useRefetchOnTabChange(state.routes[state.index]?.key, refetch);
  const slideOut = useDerivedValue(
    () => (onHome ? Math.min(1, progress.value / CONTENT_FROM) : 0),
    [onHome],
  );

  const items = state.routes.flatMap((route, index): TabBarItem[] => {
    const tab = tabFor(route.name);
    if (!tab) return [];
    const selected = state.index === index;
    return [
      {
        key: route.key,
        label: t(tab.labelKey),
        glyph: tab.glyph,
        selected,
        testID: tab.testID,
        onPress: () => {
          const event = emitter.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!selected && !event.defaultPrevented) navigateToTab(route.key);
        },
        onLongPress: () => {
          emitter.emit({ type: "tabLongPress", target: route.key });
        },
      },
    ];
  });

  return (
    <TabBar
      items={items}
      slideOut={slideOut}
      hidden={onHome && phase !== "idle"}
      accessory={active ? <JobBanner active={active} updatedAt={updatedAt} /> : undefined}
      testID="tab-bar"
    />
  );
}

const renderTabBar = (props: BottomTabBarProps) => <RouterTabBar {...props} />;

/** The banner's job is asked again on each move to another tab (the first one is the mount's). */
function useRefetchOnTabChange(tabKey: string | undefined, refetch: () => Promise<unknown>) {
  const shown = useRef(tabKey);
  useEffect(() => {
    if (shown.current === tabKey) return;
    shown.current = tabKey;
    void refetch();
  }, [refetch, tabKey]);
}

/**
 * The banner's job is asked again whenever the tabs come back into focus (a screen pushed over
 * them went back) and when the app returns to the foreground on them. The first focus is the
 * mount, which already asked.
 */
function useRefetchOnTabsReturn(refetch: () => Promise<unknown>) {
  const mounted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (mounted.current) void refetch();
      mounted.current = true;
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") void refetch();
      });
      return () => subscription.remove();
    }, [refetch]),
  );
}

/**
 * The signed-in shell (D18): Home, History and Account on a bottom tab bar, for the customer and
 * the pro alike. Flows a tab starts (a request, a quote, the phone step) are screens of the
 * `(app)` stack around this group, so they cover the bar and Back returns to the tab they left.
 * Android's hardware Back on History or Account goes to Home; on Home it leaves the app.
 */
export function TabsLayout() {
  const { t } = useTranslation();
  // An ongoing job's banner over the bar (#64): the same answer the bar draws it from, so every
  // tab root pads for it on the same render.
  const { active, refetch } = useActiveJob();
  useRefetchOnTabsReturn(refetch);

  return (
    <TabBarAccessoryContext.Provider value={active !== null}>
      <Tabs
        backBehavior="initialRoute"
        tabBar={renderTabBar}
        screenOptions={{
          headerShown: false,
          // The frame under a tab while its screen mounts: the app's page color.
          sceneStyle: { backgroundColor: tokens.colors["gray-50"] },
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.route} name={tab.route} options={{ title: t(tab.labelKey) }} />
        ))}
      </Tabs>
    </TabBarAccessoryContext.Provider>
  );
}
