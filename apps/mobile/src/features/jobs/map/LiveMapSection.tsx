import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useRefetchOnReturn } from "@/features/quotes/useRequestQuotes";
import { bubbleShadow, continuousCorners, tokens } from "@/theme";

import { jobsConfig } from "../config";
import { SHEET_OVERLAP } from "../JobChrome";
import { JobMap, jobMapHeight } from "../JobMap";
import { etaOf, type JobPhase } from "../phase";

import { useLiveTracking } from "./api";
import { liveMapConfig } from "./config";
import { LiveMap } from "./LiveMap";
import type { Fix } from "./motion";
import { trackingText, type TrackingText } from "./tracking";

/** The live map takes this share of the window's height: the top of the screen, like a driving app. */
const LIVE_MAP_SHARE = 0.5;
const { stepSlideMs, transitionMs } = tokens.motion;
const CARD_STYLE = [bubbleShadow, continuousCorners];

type PlaceholderKind = "loading" | "waiting" | "offline" | "unavailable";

type JobHeroProps = {
  jobId: string;
  /** The arrival time the pro gave: the cards fall back to it without a route. */
  etaAt: string | null;
  phase: JobPhase;
  /** Where the drawn map's marker is (`travelOf`), for the phases without the live map. */
  travel: number;
  /** The pro's name inside a sentence. */
  name: string;
  /** The time the words are drawn at (`useMinuteClock`). */
  now: number;
  /** Asks for the job again: the pro stopped sharing their position, the job may have moved on. */
  refetch: () => Promise<unknown>;
};

/**
 * The top of the ongoing job: the live map while the pro is on the way, the drawn map in every
 * other phase. The box eases between the two heights, and the live map fades out as it leaves
 * (taking its polling and its map view with it), so the sheet below never jumps.
 */
export function JobHero({ jobId, etaAt, phase, travel, name, now, refetch }: JobHeroProps) {
  const { width, height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const drawn = jobMapHeight(width);
  const liveHeight = Math.max(drawn, Math.round(windowHeight * LIVE_MAP_SHARE));
  const live = phase === "onTheWay";
  const target = live ? liveHeight : drawn;
  const box = useSharedValue(target);
  useEffect(() => {
    box.value = reduceMotion
      ? target
      : withTiming(target, { duration: stepSlideMs, easing: Easing.out(Easing.cubic) });
  }, [box, reduceMotion, target]);
  const boxStyle = useAnimatedStyle(() => ({ height: box.value }));

  return (
    <Animated.View className="overflow-hidden bg-navy-900" style={boxStyle} testID="job-hero">
      {live ? (
        <Animated.View exiting={reduceMotion ? undefined : FadeOut.duration(transitionMs)}>
          <LiveMapSection
            jobId={jobId}
            etaAt={etaAt}
            height={liveHeight}
            name={name}
            now={now}
            refetch={refetch}
          />
        </Animated.View>
      ) : (
        <JobMap phase={phase} travel={travel} />
      )}
    </Animated.View>
  );
}

type LiveMapSectionProps = Omit<JobHeroProps, "phase" | "travel"> & { height: number };

/**
 * The pro's live position on the map, or a calm card saying why it is not there: loading, no
 * position shared yet, offline, or no map (no Mapbox token, or its style failed to load). The last
 * position stays on the map, dimmed, once it is older than `liveMapConfig.staleMs` or the API
 * stops sending one; the latter also asks for the job again.
 */
function LiveMapSection({ jobId, etaAt, height, name, now, refetch }: LiveMapSectionProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const usable = liveMapConfig.accessToken !== null && !failed;
  // A map that could not load is tried again when the screen or the app comes back.
  const retry = useCallback(async () => setFailed(false), []);
  useRefetchOnReturn(retry, failed);
  const { position, route } = useLiveTracking(jobId, usable);
  const latest = position.data ?? null;

  const [fix, setFix] = useState<Fix | null>(null);
  if (latest && latest.updated_at !== fix?.at) {
    setFix({ point: [latest.lng, latest.lat], heading: latest.heading_deg, at: latest.updated_at });
  }
  const lost = fix !== null && position.isSuccess && latest === null;
  const old = useIsOld(fix?.at ?? null, liveMapConfig.staleMs);
  const askForJob = useEffectEvent(() => void refetch());
  useEffect(() => {
    if (lost) askForJob();
  }, [lost]);

  const eta = etaOf(etaAt, now, jobsConfig.etaCloseMinutes);
  const text = trackingText(t, {
    name,
    route: route.data ?? null,
    etaMinutes: eta?.kind === "close" ? eta.minutes : null,
    waiting: lost || old,
  });

  if (!usable) return <MapPlaceholder kind="unavailable" name={name} height={height} />;
  if (fix === null) {
    const kind: PlaceholderKind = position.isPending
      ? "loading"
      : position.isError
        ? "offline"
        : "waiting";
    return <MapPlaceholder kind={kind} name={name} height={height} />;
  }
  return (
    <LiveMap
      fix={fix}
      stale={lost || old}
      route={route.data ?? null}
      height={height}
      cards={<MapCards text={text} />}
      onUnavailable={() => setFailed(true)}
    />
  );
}

/**
 * True once the same fix (`at`) has been on the map for `staleMs`, timed on the phone from its
 * arrival: a phone clock set wrong never makes every fix look old. A fix older than the API's own
 * limit is never sent.
 */
function useIsOld(at: string | null, staleMs: number): boolean {
  const [oldAt, setOldAt] = useState<string | null>(null);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setOldAt(at), staleMs);
    return () => clearTimeout(timer);
  }, [at, staleMs]);
  return at !== null && oldAt === at;
}

/** The time left, the distance and the street, one sentence for screen readers. */
function MapCards({ text }: { text: TrackingText }) {
  const { t } = useTranslation();
  const facts = [text.distance, text.street && t("jobs.liveMap.onStreet", { street: text.street })];
  const line = facts.filter((fact): fact is string => Boolean(fact)).join(" · ");
  return (
    <View
      accessible
      accessibilityLabel={text.summary}
      className="self-start rounded-lg bg-white px-4 py-3"
      style={CARD_STYLE}
      testID="live-map-cards"
    >
      {text.eta ? (
        <Text className="text-title-2 text-navy-900" testID="live-map-eta">
          {text.eta}
        </Text>
      ) : null}
      {line ? (
        <Text className="text-footnote text-gray-500" testID="live-map-facts">
          {line}
        </Text>
      ) : null}
      {text.waiting ? (
        <View className="mt-1 flex-row items-center gap-2" testID="live-map-waiting">
          <View className="h-2 w-2 rounded-pill bg-warning" />
          <Text className="flex-1 text-footnote text-navy-900">{t("jobs.liveMap.waiting")}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A calm card over the navy box where the live map would be, centered above the sheet's edge. */
function MapPlaceholder({
  kind,
  name,
  height,
}: {
  kind: PlaceholderKind;
  name: string;
  height: number;
}) {
  const { t } = useTranslation();
  return (
    <View
      className="items-center justify-center px-6"
      style={{ height, paddingBottom: SHEET_OVERLAP }}
      testID={`live-map-placeholder-${kind}`}
    >
      <View className="w-full gap-1 rounded-lg bg-white p-4" style={CARD_STYLE}>
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t(`jobs.liveMap.placeholder.${kind}.title`, { name })}
        </Text>
        <Text className="text-footnote text-gray-500">
          {t(`jobs.liveMap.placeholder.${kind}.body`, { name })}
        </Text>
      </View>
    </View>
  );
}
