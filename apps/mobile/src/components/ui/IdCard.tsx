import * as Haptics from "expo-haptics";
import { Gyroscope } from "expo-sensors";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityRole,
  type ViewStyle,
} from "react-native";
import {
  GestureDetector,
  useExclusiveGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";

import { continuousCorners, tokens } from "@/theme";

import {
  Back,
  CardBase,
  Front,
  PALETTE,
  type FaceMotion,
  type MotionStyle,
  type Palette,
} from "./IdCardFaces";
import {
  clampTilt,
  formatPublicCode,
  groundShadow,
  ID_CARD_BASE,
  ID_CARD_BASE_HEIGHT,
  ID_CARD_BASE_WIDTH,
  idCardGeometry,
  MAX_TILT,
  parallaxOffset,
  placeOf,
  SHEEN_REST,
  sheenPose,
  type IdCardFace,
  type IdCardVariant,
} from "./idCardModel";

export type IdCardProps = {
  variant: IdCardVariant;
  /** The card's width in dp; everything scales from it (`ID_CARD_BASE_WIDTH` is the design size). */
  width: number;
  name?: string;
  city?: string;
  state?: string;
  /** The person's own number, formatted by the caller. In the app only: never on a shareable render. */
  phone?: string;
  photoUri?: string;
  /** The 8-character public code (#290); the back engraves it grouped, `K7Q2-9MXA`. */
  publicCode?: string;
  /**
   * The platform approved this pro (`verification_status` "approved"): the verified seal follows
   * the name. Only ever from the API: never set it for anyone the API has not approved.
   */
  verified?: boolean;
  /** When the person joined, formatted by the caller ("November 2026"): the footer's line. */
  memberSince?: string;
  /**
   * The image for the share sheet: the exact ID-1 proportions, no phone, no 3D, no gestures, no
   * moving light, so the PNG looks the same on every phone.
   */
  shareable?: boolean;
  /**
   * Tilt, flip and gyroscope. Off, the card holds still until a parent brings it alive; turned off
   * while it shows its back, it turns back to the front.
   */
  interactive?: boolean;
  onFlip?: (face: IdCardFace) => void;
  /** The photo finished loading, or failed: the share render waits for it before capturing. */
  onPhotoLoadEnd?: () => void;
  testID?: string;
};

const HALF_TURN = 180;
/** Within this many degrees of its own rest a hidden face is parked: turned away, not tracked. */
const PARKED = 0.5;
/** The lean of a drag across the whole card: the limit comes before the flip threshold. */
const DRAG_TILT = 48;
/** A horizontal drag this long activates the pan; a vertical one this long leaves it to the list. */
const PAN_ACTIVATE_DP = 8;
const PAN_FAIL_DP = 12;
/** A release faster than this, or past this fraction of the width, turns the card over. */
const FLING_VELOCITY = 600;
const FLIP_FRACTION = 0.35;
/** The card rises to the finger, and a little more at the middle of a flip. */
const LIFT_SCALE = 1.03;
const FLIP_LIFT = 0.05;
/** The gyroscope nudges the card like a thing with inertia: a steady turn of 1 rad/s leans it to the
 * cap, and it settles back in about half a second once the phone holds still. */
const GYRO_INTERVAL_MS = 33;
const GYRO_GAIN = 2;
const GYRO_DECAY = 0.86;
const MAX_GYRO_TILT = 14;
const GYRO_TIMING = { duration: GYRO_INTERVAL_MS, easing: Easing.linear };
// Springs (damping ratio = damping / (2 * sqrt(stiffness))): a flip at 0.72, a few degrees past
// the half turn and back; a settle at 0.78, a hair of overshoot; a lift at 0.56, quick to the finger.
const FLIP_SPRING = { damping: 19, stiffness: 175 };
const SETTLE_SPRING = { damping: 22, stiffness: 200 };
const LIFT_SPRING = { damping: 20, stiffness: 320 };
// The crossfade is the Reduce Motion flip itself, so Reanimated must not skip it to the end.
const FADE = { duration: tokens.motion.transitionMs, reduceMotion: ReduceMotion.Never };
/**
 * How high each layer floats over the face, in design dp (negative: under it). A lean slides them
 * against each other: the print sinks under the laminate; the photo plate, the ink and the PRO
 * badge stand on it.
 */
const DEPTH = { print: -5, ink: 4.5 } as const;
/** How far the foil's bright streak travels at the full lean, as a fraction of its band. */
const FOIL_TRAVEL = 0.8;
/** The PRO badge's width, as a fraction of the photo plate's (IdCardFaces draws it so). */
const BADGE_WIDTH = 0.5;
/** The plastic's edge shows a little at rest too, as from a camera slightly above the card. */
const EDGE_REST_DROP = 0.5;
/** Room around the card for its shadow, in design dp. */
const SHADOW_ROOM = 28;
/** The ground shadow's layers: spread and drop in design dp, opacity each (they add up). */
const SHADOW_LAYERS = [
  { spread: 0.5, drop: 1, opacity: 0.07 },
  { spread: 1, drop: 2, opacity: 0.05 },
  { spread: 2, drop: 3, opacity: 0.04 },
  { spread: 3, drop: 4.5, opacity: 0.032 },
  { spread: 4.5, drop: 6, opacity: 0.025 },
  { spread: 6.5, drop: 8, opacity: 0.018 },
  { spread: 9, drop: 10.5, opacity: 0.012 },
] as const;

type Tilt = { x: SharedValue<number>; y: SharedValue<number> };

/** Which face looks out: the front until the turn passes edge-on, then the back. */
type Side = "front" | "back";

/**
 * Whether `side` looks out at this turn. Every animated view costs a shadow-tree commit per frame
 * on Android (Reanimated's synchronous UI-props path is off in this build), so the layers of the
 * face that looks away hold still: they snap to the lean while the card passes edge-on, unseen.
 */
function looksOut(turn: number, side: Side): boolean {
  "worklet";
  return Math.abs(turn) < HALF_TURN / 2 === (side === "front");
}

type Layer = { tilt: Tilt; turn: SharedValue<number>; side: Side; still: boolean };

/** One layer's parallax at `depth` design dp; still under Reduce Motion and while turned away. */
function useLayerStyle({ tilt, turn, side, still }: Layer, depth: number, unit: number) {
  return useAnimatedStyle(() => {
    if (still || !looksOut(turn.value, side)) return { transform: [] };
    const offset = parallaxOffset(tilt.x.value, tilt.y.value, depth * unit);
    return { transform: [{ translateX: offset.x }, { translateY: offset.y }] };
  });
}

/** The foil's streak, sliding across its band of `band` dp as the card leans. */
function useFoilStyle({ tilt, turn, side, still }: Layer, band: number) {
  return useAnimatedStyle(() => {
    if (still || !looksOut(turn.value, side)) return { transform: [] };
    const sweep = clampTilt(tilt.y.value - tilt.x.value * 0.5) / MAX_TILT;
    return { transform: [{ translateX: sweep * band * FOIL_TRAVEL }] };
  });
}

/** The band of light follows the lean, and brightens with it; under Reduce Motion it holds still. */
function useSheenStyle({ tilt, turn, side, still }: Layer, width: number, height: number) {
  return useAnimatedStyle(() => {
    if (still || !looksOut(turn.value, side)) return { opacity: SHEEN_REST, transform: [] };
    const pose = sheenPose(tilt.x.value, tilt.y.value, width, height);
    return {
      opacity: pose.strength,
      transform: [{ translateX: pose.translateX }, { translateY: pose.translateY }],
    };
  });
}

type Geometry = { width: number; height: number; unit: number };

/**
 * The front's moving layers: the print, the ink (with the photo plate and the PRO badge), the two
 * foils and the light. Every view gets its own animated style: a style shared by two views only
 * drives one of them in Jest.
 */
function useFrontMotion(layer: Omit<Layer, "side">, { width, height, unit }: Geometry): FaceMotion {
  const front: Layer = { ...layer, side: "front" };
  return {
    print: useLayerStyle(front, DEPTH.print, unit),
    ink: useLayerStyle(front, DEPTH.ink, unit),
    foil: useFoilStyle(front, width),
    badgeFoil: useFoilStyle(front, ID_CARD_BASE.photo.width * unit * BADGE_WIDTH),
    sheen: useSheenStyle(front, width, height),
  };
}

/** The back's moving layers: the print, the ink and the light. */
function useBackMotion(layer: Omit<Layer, "side">, { width, height, unit }: Geometry): FaceMotion {
  const back: Layer = { ...layer, side: "back" };
  return {
    print: useLayerStyle(back, DEPTH.print, unit),
    ink: useLayerStyle(back, DEPTH.ink, unit),
    sheen: useSheenStyle(back, width, height),
  };
}

/** The shadow the card casts: soft layered rounded rects, drawn once, moved on the UI thread. */
function GroundShadow({
  palette,
  unit,
  style,
  testID,
}: {
  palette: Palette;
  unit: number;
  style: MotionStyle;
  testID?: string;
}) {
  const room = SHADOW_ROOM;
  const radius = ID_CARD_BASE.radius;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: "absolute",
          top: -room * unit,
          left: -room * unit,
          right: -room * unit,
          bottom: -room * unit,
        },
        style,
      ]}
      testID={testID}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${ID_CARD_BASE_WIDTH + room * 2} ${ID_CARD_BASE_HEIGHT + room * 2}`}
      >
        {SHADOW_LAYERS.map(({ spread, drop, opacity }) => (
          <Rect
            key={spread}
            x={room - spread}
            y={room - spread + drop}
            width={ID_CARD_BASE_WIDTH + spread * 2}
            height={ID_CARD_BASE_HEIGHT + spread * 2}
            rx={radius + spread}
            fill={palette.shadow}
            opacity={opacity}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

function faceStyle(palette: Palette, width: number, height: number, unit: number): ViewStyle[] {
  return [
    {
      width,
      height,
      borderRadius: ID_CARD_BASE.radius * unit,
      backgroundColor: palette.surface,
      backfaceVisibility: "hidden",
    },
    continuousCorners,
  ];
}

function clipStyle(unit: number): ViewStyle[] {
  return [
    StyleSheet.absoluteFill,
    { borderRadius: ID_CARD_BASE.radius * unit, overflow: "hidden" },
    continuousCorners,
  ];
}

/**
 * The ID card (#250, #291, v2): "Hello, I'm:", the framed photo, the name (with the verified seal
 * when the API approved the pro), the city and state, the person's own phone, the member-since
 * line; on the back the engraved public code. Pearl white for a customer, deep green with lime foil
 * for a pro: two materials, not two fills.
 *
 * It is a physical object: a slab of plastic with an edge, standing over its own shadow. It leans
 * toward a drag and with the phone's motion (`expo-sensors` gyroscope); its layers (the print, the
 * photo, the ink, the badge) slide against each other, a band of light and the foil's streak move
 * across it, and the shadow moves the other way. A tap or a swipe turns it over (each face is its
 * own view, so Android's backface rule and iOS's double-sided layers hide the face that looks
 * away), with a haptic tick as it passes edge-on. Under Reduce Motion nothing leans, slides or
 * spins: the flip is a crossfade. Every face is one accessible element, and the flip is its action.
 *
 * The card is an image-like object at ID-1 proportions: its type ignores the font scale, and its
 * accessibility label carries everything it shows. Props update in place: nothing here is keyed on
 * them, so a parent can type into the card.
 */
export function IdCard({
  variant,
  width,
  name = "",
  city,
  state,
  phone,
  photoUri,
  publicCode,
  verified = false,
  memberSince,
  shareable = false,
  interactive = true,
  onFlip,
  onPhotoLoadEnd,
  testID,
}: IdCardProps) {
  const { t } = useTranslation();
  // Reanimated reads the system setting once at app start, so this never changes while mounted.
  const reduceMotion = useReducedMotion();
  const gradientId = useId().replace(/:/g, "");
  const palette = PALETTE[variant];
  const geometry = idCardGeometry(width);
  const { height, unit } = geometry;
  const perspective = ID_CARD_BASE.perspective * unit;
  const live = interactive && !shareable;
  const still = reduceMotion || shareable;
  const place = placeOf(city, state);

  const [face, setFace] = useState<IdCardFace>("front");
  /** The face shown, readable at once from a gesture's JS callback (state would lag a render). */
  const shown = useSharedValue<IdCardFace>("front");

  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const gyroX = useSharedValue(0);
  const gyroY = useSharedValue(0);
  const lift = useSharedValue(1);
  /** Degrees turned around the vertical axis: 0 front, ±180 back. */
  const turn = useSharedValue(0);
  /** The Reduce Motion flip: 0 front, 1 back. */
  const fade = useSharedValue(0);
  /** A person's flip ticks once as the card passes edge-on; a card set back at rest never does. */
  const tickArmed = useSharedValue(false);
  const tiltX = useDerivedValue(() => clampTilt(dragX.value + gyroX.value));
  const tiltY = useDerivedValue(() => clampTilt(dragY.value + gyroY.value));
  const tilt: Tilt = { x: tiltX, y: tiltY };

  // Gestures reach JS a moment after they end: a tap queued just as the card is set at rest must
  // not turn it over again after the rest has brought its front back.
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const tick = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  };

  /** Turns the card over; `direction` is the way a swipe sent it (a tap turns it to the right). */
  const flip = (direction: 1 | -1) => {
    if (!liveRef.current) return;
    const next: IdCardFace = shown.value === "front" ? "back" : "front";
    shown.value = next;
    setFace(next);
    if (reduceMotion) {
      fade.value = withTiming(next === "back" ? 1 : 0, FADE);
      // A crossfade has no edge-on moment: the tick comes with the tap.
      tick();
    } else {
      tickArmed.value = true;
      turn.value = withSpring(next === "back" ? HALF_TURN * direction : 0, FLIP_SPRING);
    }
    onFlip?.(next);
  };

  // A card set back at rest (a parent turns `interactive` off) shows its front again, turning back
  // the way it came: still, nothing could turn it over to the front any more. The accessible face
  // follows in this render; the animation and the parent's callback in the effect.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) setFace("front");
  }
  useEffect(() => {
    if (live || shown.value === "front") return;
    shown.value = "front";
    tickArmed.value = false;
    if (reduceMotion) fade.value = withTiming(0, FADE);
    else turn.value = withSpring(0, FLIP_SPRING);
    onFlip?.("front");
  }, [live, reduceMotion, shown, fade, turn, tickArmed, onFlip]);

  const gyro = live && !reduceMotion;
  useEffect(() => {
    if (!gyro) return;
    let subscribed = true;
    let subscription: { remove(): void } | null = null;
    let nudgeX = 0;
    let nudgeY = 0;
    void Gyroscope.isAvailableAsync().then((available) => {
      if (!subscribed || !available) return;
      Gyroscope.setUpdateInterval(GYRO_INTERVAL_MS);
      subscription = Gyroscope.addListener(({ x, y }) => {
        // Rotation rates in rad/s around the phone's x (pitch) and y (roll) axes. The card
        // counter-turns, as a loose card would lag behind the phone, then settles.
        nudgeX = clampTilt(nudgeX * GYRO_DECAY + x * GYRO_GAIN, MAX_GYRO_TILT);
        nudgeY = clampTilt(nudgeY * GYRO_DECAY - y * GYRO_GAIN, MAX_GYRO_TILT);
        gyroX.value = withTiming(nudgeX, GYRO_TIMING);
        gyroY.value = withTiming(nudgeY, GYRO_TIMING);
      });
    });
    return () => {
      subscribed = false;
      subscription?.remove();
      gyroX.value = withTiming(0, GYRO_TIMING);
      gyroY.value = withTiming(0, GYRO_TIMING);
    };
  }, [gyro, gyroX, gyroY]);

  const pan = usePanGesture({
    enabled: live,
    testID: testID ? `${testID}-pan` : undefined,
    activeOffsetX: [-PAN_ACTIVATE_DP, PAN_ACTIVATE_DP],
    failOffsetY: [-PAN_FAIL_DP, PAN_FAIL_DP],
    onBegin: () => {
      "worklet";
      if (!reduceMotion) lift.value = withSpring(LIFT_SCALE, LIFT_SPRING);
    },
    onUpdate: (event) => {
      "worklet";
      if (reduceMotion) return;
      // The side under the finger dips away: a drag to the right turns the right edge back.
      dragY.value = clampTilt((event.translationX / width) * DRAG_TILT);
      dragX.value = clampTilt((-event.translationY / height) * DRAG_TILT);
    },
    onDeactivate: (event) => {
      "worklet";
      dragX.value = withSpring(0, SETTLE_SPRING);
      dragY.value = withSpring(0, SETTLE_SPRING);
      const swipe =
        !event.canceled &&
        (Math.abs(event.velocityX) >= FLING_VELOCITY ||
          Math.abs(event.translationX) >= width * FLIP_FRACTION);
      if (swipe) runOnJS(flip)(event.translationX > 0 ? 1 : -1);
    },
    onFinalize: () => {
      "worklet";
      lift.value = withSpring(1, LIFT_SPRING);
    },
  });
  const tap = useTapGesture({
    enabled: live,
    testID: testID ? `${testID}-tap` : undefined,
    // A tap has no distance limit by default (only 500 ms): a quick scroll flick that starts on
    // the card would turn it over. Past the pan's activation distance it is a drag, not a tap.
    maxDistance: PAN_ACTIVATE_DP,
    onActivate: () => {
      "worklet";
      runOnJS(flip)(1);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);

  // After the effects that write `turn` (a value a hook reads is frozen for the React Compiler).
  // The flip's midpoint: the card passes edge-on (the haptic tick of a person's flip).
  useAnimatedReaction(
    () => Math.abs(turn.value) >= HALF_TURN / 2,
    (past, before) => {
      // A flip crosses the half turn once (its overshoot stays past it), so an armed card ticks
      // once per flip; a card set back at rest is disarmed first.
      if (before === null || past === before || !tickArmed.value) return;
      runOnJS(tick)();
    },
  );

  /** The card's pose: its lift (and the extra lift mid-flip) and its lean. */
  const frontStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1 - fade.value, transform: [{ perspective }] };
    // Resting on its back, the front waits turned away: no commit per frame for a hidden face.
    if (Math.abs(turn.value) >= HALF_TURN - PARKED) return parkedPose(perspective);
    const scale = lift.value + Math.sin((Math.abs(turn.value) * Math.PI) / HALF_TURN) * FLIP_LIFT;
    return {
      opacity: 1,
      transform: [
        { perspective },
        { scale },
        { rotateX: `${tilt.x.value}deg` },
        { rotateY: `${turn.value + tilt.y.value}deg` },
      ],
    };
  });

  const backStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: fade.value, transform: [{ perspective }] };
    if (Math.abs(turn.value) <= PARKED) return parkedPose(perspective);
    const scale = lift.value + Math.sin((Math.abs(turn.value) * Math.PI) / HALF_TURN) * FLIP_LIFT;
    return {
      opacity: 1,
      transform: [
        { perspective },
        { scale },
        { rotateX: `${tilt.x.value}deg` },
        { rotateY: `${turn.value + HALF_TURN + tilt.y.value}deg` },
      ],
    };
  });

  /**
   * The plastic's edge: the card's slab, one thickness behind whichever face looks out, so on
   * screen it peeks out the same way from both. It turns with the card, then slides in the card's
   * own plane, whose x runs the other way seen from the back.
   */
  const edgeStyle = useAnimatedStyle(() => {
    const thickness = ID_CARD_BASE.thickness * unit;
    const rest = thickness * EDGE_REST_DROP;
    if (reduceMotion) return { transform: [{ perspective }, { translateY: rest }] };
    const scale = lift.value + Math.sin((Math.abs(turn.value) * Math.PI) / HALF_TURN) * FLIP_LIFT;
    const offset = parallaxOffset(tilt.x.value, tilt.y.value, -thickness);
    const facing = Math.abs(turn.value) < HALF_TURN / 2 ? 1 : -1;
    return {
      transform: [
        { perspective },
        { scale },
        { rotateX: `${tilt.x.value}deg` },
        { rotateY: `${turn.value + tilt.y.value}deg` },
        { translateX: offset.x * facing },
        { translateY: offset.y + rest },
      ],
    };
  });

  const shadowStyle = useAnimatedStyle(() => {
    if (reduceMotion) return groundShadowStyle(groundShadow(0, 0, 1, 0, unit));
    return groundShadowStyle(
      groundShadow(tilt.x.value, tilt.y.value, lift.value, turn.value, unit),
    );
  });

  const frontMotion = useFrontMotion({ tilt, turn, still }, geometry);
  const backMotion = useBackMotion({ tilt, turn, still }, geometry);

  const frontLabel = [
    t("idCard.a11y.card"),
    variant === "pro" ? t("idCard.pro") : null,
    name.trim() || t("idCard.a11y.unnamed"),
    verified ? t("idCard.a11y.verified") : null,
    place || null,
    // Read out as it is drawn: never on the share render, which draws none.
    (!shareable && phone) || null,
    memberSince ? t("idCard.a11y.memberSince", { date: memberSince }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  const backLabel = publicCode
    ? t("idCard.a11y.back", { code: formatPublicCode(publicCode) })
    : t("idCard.a11y.backBlank");

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "activate") flip(1);
  };
  // One accessible element per face: the face that looks away is hidden from assistive technology.
  const role: AccessibilityRole = live ? "button" : "image";
  const hint = live ? t("idCard.a11y.hint") : undefined;
  const actions = live ? [{ name: "activate", label: t("idCard.a11y.flip") }] : undefined;
  const showingFront = face === "front";

  const front = (motion: FaceMotion) => (
    <Front
      variant={variant}
      palette={palette}
      unit={unit}
      width={width}
      gradientId={gradientId}
      name={name}
      place={place}
      phone={shareable ? undefined : phone}
      photoUri={photoUri}
      verified={verified}
      memberSince={memberSince}
      motion={motion}
      onPhotoLoadEnd={onPhotoLoadEnd}
      testID={testID}
    />
  );

  if (shareable) {
    // Flat-lit and square to the camera: no shadow, no edge, the light at rest.
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={frontLabel}
        testID={testID}
        style={[{ width, height }, ...faceStyle(palette, width, height, unit)]}
      >
        <View style={clipStyle(unit)}>
          <CardBase palette={palette} gradientId={gradientId} />
          {front({ sheen: { opacity: SHEEN_REST } })}
        </View>
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }} testID={testID}>
        <GroundShadow
          palette={palette}
          unit={unit}
          style={shadowStyle}
          testID={testID ? `${testID}-shadow` : undefined}
        />
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: ID_CARD_BASE.radius * unit, backgroundColor: palette.surface },
            continuousCorners,
            edgeStyle,
          ]}
          testID={testID ? `${testID}-edge` : undefined}
        >
          <View
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: ID_CARD_BASE.radius * unit, backgroundColor: palette.edge },
              continuousCorners,
            ]}
          />
        </Animated.View>
        <Animated.View
          accessible
          accessibilityRole={role}
          accessibilityLabel={frontLabel}
          accessibilityHint={hint}
          accessibilityActions={actions}
          onAccessibilityAction={live ? onAccessibilityAction : undefined}
          accessibilityElementsHidden={!showingFront}
          importantForAccessibility={showingFront ? "yes" : "no-hide-descendants"}
          testID={testID ? `${testID}-front` : undefined}
          style={[...faceStyle(palette, width, height, unit), frontStyle]}
        >
          <View style={clipStyle(unit)}>
            <CardBase palette={palette} gradientId={`${gradientId}-f`} />
            {front(frontMotion)}
          </View>
        </Animated.View>
        <Animated.View
          accessible
          accessibilityRole={role}
          accessibilityLabel={backLabel}
          accessibilityHint={hint}
          accessibilityActions={actions}
          onAccessibilityAction={live ? onAccessibilityAction : undefined}
          accessibilityElementsHidden={showingFront}
          importantForAccessibility={showingFront ? "no-hide-descendants" : "yes"}
          testID={testID ? `${testID}-back` : undefined}
          style={[StyleSheet.absoluteFill, ...faceStyle(palette, width, height, unit), backStyle]}
        >
          <View style={clipStyle(unit)}>
            <CardBase palette={palette} gradientId={`${gradientId}-b`} />
            <Back
              palette={palette}
              unit={unit}
              gradientId={`${gradientId}-b`}
              publicCode={publicCode}
              motion={backMotion}
              testID={testID}
            />
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function groundShadowStyle(shadow: ReturnType<typeof groundShadow>) {
  "worklet";
  return {
    opacity: shadow.opacity,
    transform: [
      { translateX: shadow.translateX },
      { translateY: shadow.translateY },
      { scaleX: shadow.scaleX },
      { scaleY: shadow.scaleY },
    ],
  };
}

/** A face turned away and still: half a turn round, square, at rest. */
function parkedPose(perspective: number) {
  "worklet";
  return {
    opacity: 1,
    transform: [{ perspective }, { scale: 1 }, { rotateX: "0deg" }, { rotateY: `${HALF_TURN}deg` }],
  };
}
