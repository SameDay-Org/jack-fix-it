import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";

import { ControlIcon } from "@/components/icons";
import { tokens, withOpacity } from "@/theme";

import type { JobPhase } from "./phase";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// The drawing's own grid: a 320 x 200 block of streets, scaled to cover the map's box.
const VIEW_W = 320;
const VIEW_H = 200;
/** The map's height: the screen's width at the drawing's ratio, never taller than this. */
const MAX_HEIGHT = 280;

// City blocks between 16-unit streets; one is a park.
const BLOCKS: readonly { x: number; y: number; w: number; h: number; park?: boolean }[] = [
  { x: -8, y: -8, w: 68, h: 52 },
  { x: 76, y: -8, w: 72, h: 52 },
  { x: 164, y: -8, w: 72, h: 52, park: true },
  { x: 252, y: -8, w: 76, h: 52 },
  { x: -8, y: 60, w: 68, h: 52 },
  { x: 76, y: 60, w: 72, h: 52 },
  { x: 164, y: 60, w: 72, h: 52 },
  { x: 252, y: 60, w: 76, h: 52 },
  { x: -8, y: 128, w: 68, h: 80, park: true },
  { x: 76, y: 128, w: 72, h: 80 },
  { x: 164, y: 128, w: 72, h: 80 },
  { x: 252, y: 128, w: 76, h: 80 },
];
const BLOCK_RADIUS = 8;
const PARK_OPACITY = 0.35;

/** The route along the street centers, from the pro's start to the customer's door. */
const ROUTE: readonly (readonly [number, number])[] = [
  [68, 160],
  [68, 120],
  [156, 120],
  [156, 52],
  [272, 52],
];
const SEGMENTS = ROUTE.slice(1).map(([x, y], index) => {
  const [px, py] = ROUTE[index];
  return { x0: px, y0: py, dx: x - px, dy: y - py, length: Math.hypot(x - px, y - py) };
});
const ROUTE_LENGTH = SEGMENTS.reduce((sum, segment) => sum + segment.length, 0);
const ROUTE_PATH = ROUTE.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join("");
const [HOME_X, HOME_Y] = ROUTE[ROUTE.length - 1];
const ROUTE_WIDTH = 4;
const AHEAD_DASH = "2 8";
const AHEAD_OPACITY = 0.45;

// The pins, in dp.
const MARKER = 20;
const MARKER_CORE = 12;
const HOME = 32;
const HOME_GLYPH = 18;
const HOUSE_PATH = "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z";
const BADGE = 16;
const PULSE_MS = 1400;
const PULSE_SCALE = 2.4;
const PULSE_OPACITY = 0.5;
const { stepSlideMs } = tokens.motion;

const navy900 = tokens.colors["navy-900"];
const navy700 = tokens.colors["navy-700"];
const green500 = tokens.colors["green-500"];
const green700 = tokens.colors["green-700"];

/** The point `share` of the way along the route, in drawing units (a worklet). */
function pointAt(share: number): { x: number; y: number } {
  "worklet";
  let left = Math.min(1, Math.max(0, share)) * ROUTE_LENGTH;
  for (const segment of SEGMENTS) {
    if (left <= segment.length) {
      const part = segment.length === 0 ? 0 : left / segment.length;
      return { x: segment.x0 + segment.dx * part, y: segment.y0 + segment.dy * part };
    }
    left -= segment.length;
  }
  return { x: HOME_X, y: HOME_Y };
}

export type JobMapProps = {
  phase: JobPhase;
  /** How far along the route the pro's marker is, 0 to 1 (see `travelOf`). */
  travel: number;
  /** How much of the map's bottom edge something covers (the sheet over it): the chip sits above. */
  covered?: number;
  testID?: string;
};

/**
 * A drawn map, not a real one (#103 brings that): navy blocks and streets, the route to the
 * customer's door in lime, the part still ahead dashed, and the pro's marker on it. The marker's
 * place comes from time alone (the share of the On my way span that passed), never a location,
 * and a chip says so while it moves. It pulses while the pro is on the way, the door pulses while
 * they work, and a check sits on it once done. Reduce Motion: no pulse, no glide. Decorative to
 * screen readers: the headline and the progress say the same in words.
 */
export function JobMap({ phase, travel, covered = 0, testID = "job-map" }: JobMapProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const height = Math.min(MAX_HEIGHT, (width * VIEW_H) / VIEW_W);
  // "Cover": the drawing fills the box, centered, its overflow cut.
  const scale = Math.max(width / VIEW_W, height / VIEW_H);
  const offsetX = (width - VIEW_W * scale) / 2;
  const offsetY = (height - VIEW_H * scale) / 2;

  const routed = phase !== "attention" && phase !== "cancelled";
  const atDoor = phase !== "scheduled" && phase !== "onTheWay";
  const moving = phase === "onTheWay";
  const done = phase === "finished" || phase === "done";

  // The marker only moves on while the pro is on the way: a later ETA never walks it back.
  // Adjusted while rendering (React's pattern for state derived from the previous render).
  const [reached, setReached] = useState(travel);
  const target = moving ? Math.max(reached, travel) : travel;
  if (target !== reached) setReached(target);

  const progress = useSharedValue(target);
  useEffect(() => {
    progress.value = reduceMotion
      ? target
      : withTiming(target, { duration: stepSlideMs, easing: Easing.out(Easing.cubic) });
  }, [progress, reduceMotion, target]);

  const traveled = useAnimatedProps(() => ({
    strokeDashoffset: ROUTE_LENGTH * (1 - progress.value),
  }));
  const markerStyle = useAnimatedStyle(() => {
    const point = pointAt(progress.value);
    return {
      transform: [
        { translateX: offsetX + point.x * scale - MARKER / 2 },
        { translateY: offsetY + point.y * scale - MARKER / 2 },
      ],
    };
  });

  const homeLeft = offsetX + HOME_X * scale - HOME / 2;
  const homeTop = offsetY + HOME_Y * scale - HOME / 2;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="overflow-hidden bg-navy-900"
      style={{ width, height }}
      testID={testID}
    >
      <Svg
        width={width}
        height={height}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {BLOCKS.map((block, index) => (
          <Rect
            key={index}
            x={block.x}
            y={block.y}
            width={block.w}
            height={block.h}
            rx={BLOCK_RADIUS}
            fill={block.park ? green700 : navy700}
            fillOpacity={block.park ? PARK_OPACITY : 1}
          />
        ))}
        {routed ? (
          <>
            <Path
              d={ROUTE_PATH}
              stroke={green500}
              strokeOpacity={AHEAD_OPACITY}
              strokeWidth={ROUTE_WIDTH}
              strokeDasharray={AHEAD_DASH}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <AnimatedPath
              d={ROUTE_PATH}
              stroke={green500}
              strokeWidth={ROUTE_WIDTH}
              strokeDasharray={`${ROUTE_LENGTH} ${ROUTE_LENGTH}`}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              animatedProps={traveled}
            />
          </>
        ) : null}
      </Svg>

      <View
        className="absolute items-center justify-center"
        style={{ left: homeLeft, top: homeTop, width: HOME, height: HOME }}
        testID={`${testID}-home`}
      >
        {phase === "working" ? <Pulse size={HOME} color={green500} active={!reduceMotion} /> : null}
        <View
          className="items-center justify-center rounded-pill bg-white"
          style={{ width: HOME, height: HOME }}
        >
          <Svg width={HOME_GLYPH} height={HOME_GLYPH} viewBox="0 0 24 24">
            <Path d={HOUSE_PATH} fill={navy900} />
          </Svg>
        </View>
        {done ? (
          <View
            className="absolute items-center justify-center rounded-pill bg-green-500"
            style={{ width: BADGE, height: BADGE, right: -BADGE / 4, top: -BADGE / 4 }}
            testID={`${testID}-done`}
          >
            <ControlIcon name="check" size={BADGE - 4} color={navy900} />
          </View>
        ) : null}
      </View>

      {routed && !atDoor ? (
        <Animated.View
          className="absolute left-0 top-0 items-center justify-center"
          style={[{ width: MARKER, height: MARKER }, markerStyle]}
          testID={`${testID}-marker`}
        >
          {moving ? <Pulse size={MARKER} color={green500} active={!reduceMotion} /> : null}
          <View
            className="items-center justify-center rounded-pill bg-white"
            style={{ width: MARKER, height: MARKER }}
          >
            <View
              className="rounded-pill bg-green-500"
              style={{ width: MARKER_CORE, height: MARKER_CORE }}
            />
          </View>
        </Animated.View>
      ) : null}

      {moving ? (
        <View
          // Bottom right, the one corner the route, the door and the way back leave free.
          className="absolute right-4 max-w-[60%] rounded-pill px-3 py-1"
          style={{
            bottom: covered + CHIP_GAP,
            backgroundColor: withOpacity("navy-900", CHIP_OPACITY),
          }}
          testID={`${testID}-estimate`}
        >
          <Text className="text-caption text-white">{t("jobs.map.estimate")}</Text>
        </View>
      ) : null}
    </View>
  );
}

const CHIP_OPACITY = 0.8;
const CHIP_GAP = 8;

/** A soft ring growing out of a pin and fading, over and over; nothing under Reduce Motion. */
function Pulse({ size, color, active }: { size: number; color: string; active: boolean }) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!active) return;
    pulse.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }),
      -1,
    );
    return () => {
      cancelAnimation(pulse);
      pulse.value = 0;
    };
  }, [active, pulse]);

  return active ? <PulseRing size={size} color={color} pulse={pulse} /> : null;
}

function PulseRing({
  size,
  color,
  pulse,
}: {
  size: number;
  color: string;
  pulse: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: PULSE_OPACITY * (1 - pulse.value),
    transform: [{ scale: 1 + (PULSE_SCALE - 1) * pulse.value }],
  }));
  return (
    <Animated.View
      className="absolute rounded-pill"
      style={[{ width: size, height: size, backgroundColor: color }, style]}
      testID="job-map-pulse"
    />
  );
}
