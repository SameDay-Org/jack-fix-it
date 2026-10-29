import { Tabs, type BottomTabBarProps } from "expo-router/js-tabs";
import { useTranslation } from "react-i18next";
import { useDerivedValue } from "react-native-reanimated";

import { TabBar, type TabBarItem } from "@/components/ui";
import { CONTENT_FROM, usePanelHandoff, usePanelHandoffContext } from "@/features/auth";
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
  const { progress } = usePanelHandoffContext();
  const { phase } = usePanelHandoff();
  const slideOut = useDerivedValue(() => Math.min(1, progress.value / CONTENT_FROM));

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

  return <TabBar items={items} slideOut={slideOut} hidden={phase !== "idle"} testID="tab-bar" />;
}

const renderTabBar = (props: BottomTabBarProps) => <RouterTabBar {...props} />;

/**
 * The signed-in shell (D18): Home, History and Account on a bottom tab bar, for the customer and
 * the pro alike. Flows a tab starts (a request, a quote, the phone step) are screens of the
 * `(app)` stack around this group, so they cover the bar and Back returns to the tab they left.
 * Android's hardware Back on History or Account goes to Home; on Home it leaves the app.
 */
export function TabsLayout() {
  const { t } = useTranslation();

  return (
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
  );
}
