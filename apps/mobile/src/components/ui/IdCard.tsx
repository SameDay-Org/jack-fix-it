import * as Haptics from "expo-haptics";
import { Gyroscope } from "expo-sensors";
import { useEffect, useId, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type AccessibilityRole,
  type TextStyle,
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
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { SILHOUETTE_PATH, SILHOUETTE_VIEW_BOX } from "@/components/icons";
import { bubbleShadow, continuousCorners, tokens, withOpacity } from "@/theme";

import {
  formatPublicCode,
  ID_CARD_BASE,
  idCardGeometry,
  placeOf,
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
   * The image for the share sheet: the exact ID-1 proportions, safe margins, no phone, no 3D, no
   * gestures and no font scaling, so the PNG looks the same on every phone.
   */
  shareable?: boolean;
  /** Tilt, flip and gyroscope. Off, the card holds still until a parent brings it alive. */
  interactive?: boolean;
  onFlip?: (face: IdCardFace) => void;
  /** The photo finished loading, or failed: the share render waits for it before capturing. */
  onPhotoLoadEnd?: () => void;
  testID?: string;
};

type TypeStyle = keyof typeof tokens.fontSize;

type Palette = {
  surface: string;
  /** The bottom of the card darkens into this color, so a flat fill reads as a lit surface. */
  shade: string;
  shadeOpacity: number;
  text: string;
  muted: string;
  edge: string;
  /** The photo frame before a photo is set, and behind it while it loads. */
  well: string;
  wellEdge: string;
  silhouette: string;
  /** The band of light that slides across the card as it tilts. */
  sheen: string;
  sheenOpacity: number;
  stripe: string;
  /** The engraved code and the edge that gives it depth, both at AA on the surface. */
  engraved: string;
  engravedEdge: string;
};

const PALETTE: Record<IdCardVariant, Palette> = {
  customer: {
    surface: tokens.colors.white,
    shade: tokens.colors["navy-900"],
    shadeOpacity: 0.05,
    text: tokens.colors["navy-900"],
    muted: tokens.colors["gray-500"],
    edge: withOpacity("navy-900", 0.08),
    well: tokens.colors["gray-50"],
    wellEdge: withOpacity("navy-900", 0.06),
    silhouette: withOpacity("navy-900", 0.18),
    // On white, passing light reads as a passing shade.
    sheen: tokens.colors["navy-900"],
    sheenOpacity: 0.07,
    stripe: tokens.colors["navy-900"],
    // navy-900 at 0.7 over white reads 6.6:1; the white edge below it is the debossed lip.
    engraved: withOpacity("navy-900", 0.7),
    engravedEdge: tokens.colors.white,
  },
  pro: {
    surface: tokens.colors["green-700"],
    shade: tokens.colors["navy-900"],
    shadeOpacity: 0.35,
    text: tokens.colors.white,
    muted: tokens.colors.white,
    edge: withOpacity("white", 0.14),
    well: withOpacity("navy-900", 0.22),
    wellEdge: withOpacity("white", 0.12),
    silhouette: withOpacity("white", 0.4),
    sheen: tokens.colors.white,
    sheenOpacity: 0.18,
    stripe: tokens.colors["navy-900"],
    // No dark ink reaches AA on green-700 (solid navy-900 is 3.7:1): white (4.89:1) with a navy edge.
    engraved: tokens.colors.white,
    engravedEdge: withOpacity("navy-900", 0.55),
  },
};

const HALF_TURN = 180;
/** The most the card leans, drag and gyroscope together, in degrees. */
const MAX_TILT = 22;
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
// Springs: a flip with a hint of overshoot, a settle that never oscillates, a lift that is instant.
const FLIP_SPRING = { damping: 18, stiffness: 180 };
const SETTLE_SPRING = { damping: 16, stiffness: 200 };
const LIFT_SPRING = { damping: 20, stiffness: 320 };
// The crossfade is the Reduce Motion flip itself, so Reanimated must not skip it to the end.
const FADE = { duration: tokens.motion.transitionMs, reduceMotion: ReduceMotion.Never };
/** The silhouette's width inside the photo frame, and the overlap that hides its flat bottom edge. */
const SILHOUETTE_FRACTION = 0.62;
const SILHOUETTE_BLEED = -1;
/**
 * The sheen covers one and a half cards (Android rasterizes an SVG view at its pixel size), a
 * quarter past each edge: sliding it by a fifth of the card never shows an edge of the gradient.
 */
const SHEEN_FRAME: ViewStyle = {
  position: "absolute",
  left: "-25%",
  top: "-25%",
  width: "150%",
  height: "150%",
};
/** How far the sheen slides at the full lean, as a fraction of the card, and its strength at rest. */
const SHEEN_TRAVEL = 0.2;
const SHEEN_REST = 0.6;
/** Letter spacing at the design width, in dp: the eyebrow line, the PRO pill and the engraved code. */
const HELLO_TRACKING = 0.4;
const PRO_TRACKING = 1.5;
const CODE_TRACKING = 3;
/** The code's engraved edge: one design dp below the glyphs, softened by as much. */
const ENGRAVE_DEPTH = 1;
/** Vertical gaps in the name column at the design width, in dp. */
const PLACE_GAP = 4;
const PHONE_GAP = 2;
/**
 * The name column: two lines, and a long name shrinks before it takes a third. The floor holds on
 * iOS; Android's native fit has no floor (RN 0.88 never hands it `minimumFontScale`), so a very
 * long name keeps shrinking there until two lines fit.
 */
const NAME_LINES = 2;
const NAME_MIN_SCALE = 0.6;
const NAME_LINE_HEIGHT = 32;
/** The ascender space above the capitals, as a fraction of the font size: lifted off, the name's
 * capitals sit level with the photo's top edge (measured on Android at 25 dp: 7 dp of gap). */
const NAME_CAP_GAP = 0.2;
const PLACE_LINES = 1;

function clamp(value: number, limit: number): number {
  "worklet";
  return Math.min(limit, Math.max(-limit, value));
}

function typeStyle(style: TypeStyle, unit: number, lineHeight?: number): TextStyle {
  const { size, lineHeight: tokenLineHeight, fontWeight } = tokens.fontSize[style];
  return {
    fontSize: size * unit,
    lineHeight: (lineHeight ?? tokenLineHeight) * unit,
    fontWeight: String(fontWeight) as TextStyle["fontWeight"],
  };
}

type FaceShellProps = {
  palette: Palette;
  unit: number;
  gradientId: string;
};

/** The surface under both faces: a lit fill, darker toward the bottom. */
function Shade({ palette, gradientId }: Omit<FaceShellProps, "unit">) {
  const id = `${gradientId}-shade`;
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={palette.shade} stopOpacity={0} />
          <Stop offset="1" stopColor={palette.shade} stopOpacity={palette.shadeOpacity} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** A soft diagonal band of light, slid by the tilt (an animated style on the frame). */
function Sheen({
  palette,
  gradientId,
  style,
  testID,
}: Omit<FaceShellProps, "unit"> & {
  style: ComponentProps<typeof Animated.View>["style"];
  testID?: string;
}) {
  const id = `${gradientId}-sheen`;
  return (
    <Animated.View pointerEvents="none" style={[SHEEN_FRAME, style]} testID={testID}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0.32" stopColor={palette.sheen} stopOpacity={0} />
            <Stop offset="0.5" stopColor={palette.sheen} stopOpacity={1} />
            <Stop offset="0.68" stopColor={palette.sheen} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

type FrontProps = {
  variant: IdCardVariant;
  palette: Palette;
  unit: number;
  name: string;
  place: string;
  phone?: string;
  photoUri?: string;
  scaleFonts: boolean;
  onPhotoLoadEnd?: () => void;
  testID?: string;
};

function Front({
  variant,
  palette,
  unit,
  name,
  place,
  phone,
  photoUri,
  scaleFonts,
  onPhotoLoadEnd,
  testID,
}: FrontProps) {
  const { t } = useTranslation();
  const { padding, headerGap, columnGap, photo, proBadge } = ID_CARD_BASE;
  const photoWidth = photo.width * unit;
  const silhouette = Math.round(photoWidth * SILHOUETTE_FRACTION);
  const nameType = typeStyle("title-1", unit, NAME_LINE_HEIGHT);
  const placeType = typeStyle("callout", unit);

  return (
    <View style={{ padding: padding * unit }}>
      <Text
        allowFontScaling={scaleFonts}
        numberOfLines={1}
        style={[
          typeStyle("caption", unit),
          { color: palette.muted, textAlign: "center", letterSpacing: HELLO_TRACKING * unit },
        ]}
      >
        {t("idCard.hello")}
      </Text>
      <View style={{ flexDirection: "row", marginTop: headerGap * unit }}>
        <View style={{ alignItems: "center" }}>
          <View
            style={[
              {
                width: photoWidth,
                height: photo.height * unit,
                borderRadius: photo.radius * unit,
                borderWidth: 1,
                borderColor: palette.wellEdge,
                backgroundColor: palette.well,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "flex-end",
              },
              continuousCorners,
            ]}
          >
            <Svg
              width={silhouette}
              height={silhouette}
              viewBox={`0 0 ${SILHOUETTE_VIEW_BOX} ${SILHOUETTE_VIEW_BOX}`}
              style={{ marginBottom: SILHOUETTE_BLEED }}
            >
              <Path d={SILHOUETTE_PATH} fill={palette.silhouette} />
            </Svg>
            {photoUri ? (
              <Image
                source={{ uri: photoUri }}
                resizeMode="cover"
                onLoadEnd={onPhotoLoadEnd}
                style={StyleSheet.absoluteFill}
                testID={testID ? `${testID}-photo` : undefined}
              />
            ) : null}
          </View>
          {variant === "pro" ? (
            <View
              style={{
                marginTop: proBadge.gap * unit,
                paddingHorizontal: proBadge.paddingX * unit,
                paddingVertical: proBadge.paddingY * unit,
                borderRadius: tokens.radius.pill,
                backgroundColor: tokens.colors["green-500"],
              }}
            >
              <Text
                allowFontScaling={scaleFonts}
                numberOfLines={1}
                style={[
                  typeStyle("caption", unit),
                  { color: tokens.colors["navy-900"], letterSpacing: PRO_TRACKING * unit },
                ]}
              >
                {t("idCard.pro")}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1, marginStart: columnGap * unit }}>
          <Text
            allowFontScaling={scaleFonts}
            numberOfLines={NAME_LINES}
            adjustsFontSizeToFit
            minimumFontScale={NAME_MIN_SCALE}
            style={[
              nameType,
              {
                color: palette.text,
                includeFontPadding: false,
                marginTop: -(nameType.fontSize ?? 0) * NAME_CAP_GAP,
                minHeight: (nameType.lineHeight ?? 0) * NAME_LINES,
              },
            ]}
          >
            {name}
          </Text>
          <Text
            allowFontScaling={scaleFonts}
            numberOfLines={PLACE_LINES}
            style={[
              placeType,
              {
                color: palette.muted,
                marginTop: PLACE_GAP * unit,
                minHeight: (placeType.lineHeight ?? 0) * PLACE_LINES,
              },
            ]}
          >
            {place}
          </Text>
          {phone ? (
            <Text
              allowFontScaling={scaleFonts}
              numberOfLines={1}
              style={[
                typeStyle("footnote", unit),
                {
                  color: palette.muted,
                  marginTop: PHONE_GAP * unit,
                  fontVariant: ["tabular-nums"],
                },
              ]}
            >
              {phone}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

type BackProps = { palette: Palette; unit: number; publicCode?: string; scaleFonts: boolean };

function Back({ palette, unit, publicCode, scaleFonts }: BackProps) {
  const { stripe, padding } = ID_CARD_BASE;
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          marginTop: stripe.top * unit,
          height: stripe.height * unit,
          backgroundColor: palette.stripe,
        }}
      />
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: padding * unit }}
      >
        {publicCode ? (
          <Text
            allowFontScaling={scaleFonts}
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[
              typeStyle("headline", unit),
              {
                color: palette.engraved,
                letterSpacing: CODE_TRACKING * unit,
                fontVariant: ["tabular-nums"],
                textShadowColor: palette.engravedEdge,
                textShadowOffset: { width: 0, height: ENGRAVE_DEPTH * unit },
                textShadowRadius: ENGRAVE_DEPTH * unit,
              },
            ]}
          >
            {formatPublicCode(publicCode)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

type SheenInputs = {
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  gyroX: SharedValue<number>;
  gyroY: SharedValue<number>;
  reduceMotion: boolean;
  palette: Palette;
  width: number;
  height: number;
};

/** The band of light follows the lean, and brightens with it; under Reduce Motion it holds still. */
function useSheenStyle({
  dragX,
  dragY,
  gyroX,
  gyroY,
  reduceMotion,
  palette,
  width,
  height,
}: SheenInputs) {
  return useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: palette.sheenOpacity, transform: [] };
    const tiltX = clamp(dragX.value + gyroX.value, MAX_TILT);
    const tiltY = clamp(dragY.value + gyroY.value, MAX_TILT);
    const lean = Math.min(1, (Math.abs(tiltX) + Math.abs(tiltY)) / MAX_TILT);
    return {
      opacity: palette.sheenOpacity * (SHEEN_REST + (1 - SHEEN_REST) * lean),
      transform: [
        { translateX: (tiltY / MAX_TILT) * width * SHEEN_TRAVEL },
        { translateY: (-tiltX / MAX_TILT) * height * SHEEN_TRAVEL },
      ],
    };
  });
}

function surfaceStyle(palette: Palette, unit: number): ViewStyle[] {
  return [
    {
      borderRadius: ID_CARD_BASE.radius * unit,
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.edge,
    },
    bubbleShadow,
    continuousCorners,
  ];
}

function clipStyle(unit: number): ViewStyle[] {
  // The clip is its own view: a rounded `overflow: hidden` on the shadowed surface would cut the
  // shadow off on iOS.
  return [{ borderRadius: ID_CARD_BASE.radius * unit - 1, overflow: "hidden" }, continuousCorners];
}

/**
 * The ID card (#250, #291): "Hello, I'm:", the photo, the name, the city and state, the person's
 * own phone, and on the back the public code. Dark green for a pro, white for a customer.
 *
 * It is a physical object: it leans toward a drag and with the phone's motion (`expo-sensors`
 * gyroscope), a band of light slides across it, a tap or a swipe turns it over (both faces are
 * one view each, so Android's backface rule and iOS's double-sided layers hide the face that looks
 * away). Under Reduce Motion nothing leans or spins and the flip is a crossfade. Every face is one
 * accessible element, and the flip is its action.
 *
 * Props update in place: nothing here is keyed on them, so a parent can type into the card.
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
  const { height, unit } = idCardGeometry(width);
  const perspective = ID_CARD_BASE.perspective * unit;
  const live = interactive && !shareable;
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

  /** Turns the card over; `direction` is the way a swipe sent it (a tap turns it to the right). */
  const flip = (direction: 1 | -1) => {
    const next: IdCardFace = shown.value === "front" ? "back" : "front";
    shown.value = next;
    setFace(next);
    if (reduceMotion) {
      fade.value = withTiming(next === "back" ? 1 : 0, FADE);
    } else {
      turn.value = withSpring(next === "back" ? HALF_TURN * direction : 0, FLIP_SPRING);
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onFlip?.(next);
  };

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
        nudgeX = clamp(nudgeX * GYRO_DECAY + x * GYRO_GAIN, MAX_GYRO_TILT);
        nudgeY = clamp(nudgeY * GYRO_DECAY - y * GYRO_GAIN, MAX_GYRO_TILT);
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
      dragY.value = clamp((event.translationX / width) * DRAG_TILT, MAX_TILT);
      dragX.value = clamp((-event.translationY / height) * DRAG_TILT, MAX_TILT);
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
    onActivate: () => {
      "worklet";
      runOnJS(flip)(1);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);

  const frontStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1 - fade.value, transform: [{ perspective }] };
    const tiltX = clamp(dragX.value + gyroX.value, MAX_TILT);
    const tiltY = clamp(dragY.value + gyroY.value, MAX_TILT);
    const scale = lift.value + Math.sin((Math.abs(turn.value) * Math.PI) / HALF_TURN) * FLIP_LIFT;
    return {
      opacity: 1,
      transform: [
        { perspective },
        { scale },
        { rotateX: `${tiltX}deg` },
        { rotateY: `${turn.value + tiltY}deg` },
      ],
    };
  });

  const backStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: fade.value, transform: [{ perspective }] };
    const tiltX = clamp(dragX.value + gyroX.value, MAX_TILT);
    const tiltY = clamp(dragY.value + gyroY.value, MAX_TILT);
    const scale = lift.value + Math.sin((Math.abs(turn.value) * Math.PI) / HALF_TURN) * FLIP_LIFT;
    return {
      opacity: 1,
      transform: [
        { perspective },
        { scale },
        { rotateX: `${tiltX}deg` },
        { rotateY: `${turn.value + HALF_TURN + tiltY}deg` },
      ],
    };
  });

  // One animated style per face: a style shared by two views only drives one of them in Jest.
  // No dependency arrays: the plugin tracks them on native, and Reanimated warns when one is given.
  const sheenInputs = { dragX, dragY, gyroX, gyroY, reduceMotion, palette, width, height };
  const frontSheenStyle = useSheenStyle(sheenInputs);
  const backSheenStyle = useSheenStyle(sheenInputs);

  const frontLabel = [
    t("idCard.a11y.card"),
    variant === "pro" ? t("idCard.pro") : null,
    name.trim() || t("idCard.a11y.unnamed"),
    place || null,
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

  const front = (
    <Front
      variant={variant}
      palette={palette}
      unit={unit}
      name={name}
      place={place}
      phone={shareable ? undefined : phone}
      photoUri={photoUri}
      scaleFonts={!shareable}
      onPhotoLoadEnd={onPhotoLoadEnd}
      testID={testID}
    />
  );

  if (shareable) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={frontLabel}
        testID={testID}
        style={[{ width, height }, ...surfaceStyle(palette, unit)]}
      >
        <View style={[{ flex: 1 }, ...clipStyle(unit)]}>
          <Shade palette={palette} gradientId={gradientId} />
          <Sheen
            palette={palette}
            gradientId={gradientId}
            style={{ opacity: palette.sheenOpacity }}
          />
          {front}
        </View>
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, minHeight: height }} testID={testID}>
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
          style={[
            { minHeight: height, backfaceVisibility: "hidden" },
            ...surfaceStyle(palette, unit),
            frontStyle,
          ]}
        >
          <View style={[{ flex: 1 }, ...clipStyle(unit)]}>
            <Shade palette={palette} gradientId={gradientId} />
            <Sheen
              palette={palette}
              gradientId={`${gradientId}-f`}
              style={frontSheenStyle}
              testID={testID ? `${testID}-front-sheen` : undefined}
            />
            {front}
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
          style={[
            StyleSheet.absoluteFill,
            { backfaceVisibility: "hidden" },
            ...surfaceStyle(palette, unit),
            backStyle,
          ]}
        >
          <View style={[{ flex: 1 }, ...clipStyle(unit)]}>
            <Shade palette={palette} gradientId={`${gradientId}-b`} />
            <Sheen palette={palette} gradientId={`${gradientId}-b`} style={backSheenStyle} />
            <Back palette={palette} unit={unit} publicCode={publicCode} scaleFonts />
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
