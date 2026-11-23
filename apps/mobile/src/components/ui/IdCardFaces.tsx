import { type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";

import {
  SILHOUETTE_PATH,
  SILHOUETTE_VIEW_BOX,
  VERIFIED_SEAL_PATH,
  VERIFIED_SEAL_VIEW_BOX,
} from "@/components/icons";
import { continuousCorners, tokens, withOpacity, type ColorToken } from "@/theme";

import grainTile from "../../../assets/textures/id-card-grain.png";
import {
  decorativeBars,
  formatPublicCode,
  guillochePath,
  ID_CARD_BASE,
  ID_CARD_BASE_HEIGHT,
  ID_CARD_BASE_WIDTH,
  rosettePath,
  type IdCardVariant,
} from "./idCardModel";

/** An animated style from the card, or nothing on a still render (the share image). */
export type MotionStyle = ComponentProps<typeof Animated.View>["style"];

/** The layers of a face that move against each other as the card leans (parallax and light). */
export type FaceMotion = {
  /** The security print, sunk under the laminate. */
  print?: MotionStyle;
  /** Everything printed on the laminate: the photo plate, the text, the PRO badge. */
  ink?: MotionStyle;
  /** The foil's gradient, sliding inside its band and badge. */
  foil?: MotionStyle;
  badgeFoil?: MotionStyle;
  sheen?: MotionStyle;
};

/** How raised or sunk ink reads: the 1 dp edge above the glyphs and the one below them. */
type Relief = { above: string; below: string };

/**
 * A gradient stop's color and opacity apart: react-native-svg draws a stop's `rgba()` color
 * opaque, so a translucent stop takes its alpha through `stopOpacity`.
 */
type Tint = { color: string; opacity: number };

const tint = (token: ColorToken, opacity = 1): Tint => ({ color: tokens.colors[token], opacity });

export type Palette = {
  /** The plastic: the face's own background, under the base light. */
  surface: string;
  /** The base light: a diagonal wash from `lit` (top left) to `shade` (bottom right). */
  lit: Tint;
  shade: Tint;
  /** A soft colored bloom in one corner: the pearl's iridescence, the green's depth. */
  bloom: Tint;
  ink: string;
  muted: string;
  /** Labels in small caps, the microtext, the hairlines and the security print. */
  label: string;
  hairline: string;
  microtext: string;
  print: string;
  rosette: string;
  /** The rim: lit along the top left edge, darker along the bottom right one. */
  rimLit: Tint;
  rimDark: Tint;
  /** The plastic seen edge-on: a shade over `surface` on the slab behind the face. The shadow's ink. */
  edge: string;
  shadow: string;
  ring: string;
  well: string;
  silhouette: string;
  /** The specular band: its core and the faint pearl fringe beside it. */
  sheen: string;
  sheenOpacity: number;
  fringe: Tint;
  /** The grain tile's opacity: finer on pearl, where specks show more. */
  grain: number;
  stripe: string;
  relief: Relief;
  /** The verified seal, when the API says so: a rosette with its check cut out. */
  seal: string;
};

export const PALETTE: Record<IdCardVariant, Palette> = {
  // Pearl: white plastic with a cool shade, navy ink pressed into it.
  customer: {
    surface: tokens.colors.white,
    lit: tint("white"),
    shade: tint("navy-900", 0.06),
    bloom: tint("green-500", 0.08),
    ink: tokens.colors["navy-900"],
    muted: tokens.colors["gray-500"],
    label: tokens.colors["gray-500"],
    hairline: withOpacity("navy-900", 0.16),
    microtext: withOpacity("navy-900", 0.32),
    print: withOpacity("navy-900", 0.05),
    rosette: withOpacity("navy-900", 0.07),
    rimLit: tint("white"),
    rimDark: tint("navy-900", 0.16),
    edge: withOpacity("navy-900", 0.22),
    shadow: tokens.colors["navy-900"],
    ring: tokens.colors["navy-900"],
    well: tokens.colors["gray-50"],
    silhouette: withOpacity("navy-900", 0.16),
    sheen: tokens.colors.white,
    sheenOpacity: 0.7,
    fringe: tint("green-500", 0.1),
    grain: 0.03,
    stripe: tokens.colors["navy-900"],
    // Debossed: a shade inside the top of each glyph, a white lip under it.
    relief: { above: withOpacity("navy-900", 0.22), below: tokens.colors.white },
    seal: tokens.colors["green-700"],
  },
  // Deep green: a darker vignette, white ink standing out of it, lime foil.
  pro: {
    surface: tokens.colors["green-700"],
    lit: tint("white", 0.1),
    shade: tint("navy-900", 0.42),
    bloom: tint("green-500", 0.22),
    ink: tokens.colors.white,
    muted: tokens.colors.white,
    label: withOpacity("white", 0.86),
    hairline: withOpacity("white", 0.24),
    microtext: withOpacity("green-500", 0.7),
    print: withOpacity("white", 0.07),
    rosette: withOpacity("green-500", 0.2),
    rimLit: tint("white", 0.42),
    rimDark: tint("navy-900", 0.5),
    edge: withOpacity("navy-900", 0.45),
    shadow: tokens.colors["navy-900"],
    ring: tokens.colors["green-500"],
    well: withOpacity("navy-900", 0.28),
    silhouette: withOpacity("white", 0.38),
    sheen: tokens.colors.white,
    sheenOpacity: 0.34,
    fringe: tint("green-500", 0.24),
    grain: 0.05,
    stripe: tokens.colors["navy-900"],
    // Embossed: a lime glint on top of each glyph, a navy shadow under it.
    relief: { above: withOpacity("green-500", 0.38), below: withOpacity("navy-900", 0.6) },
    seal: tokens.colors.white,
  },
};

type TypeName = keyof typeof tokens.fontSize;

/** A type token at the card's scale; `size`/`lineHeight` override it where the card needs its own. */
function cardType(
  name: TypeName,
  unit: number,
  override: { size?: number; lineHeight?: number; weight?: TextStyle["fontWeight"] } = {},
): TextStyle {
  const token = tokens.fontSize[name];
  return {
    fontSize: (override.size ?? token.size) * unit,
    lineHeight: (override.lineHeight ?? token.lineHeight) * unit,
    fontWeight: override.weight ?? (String(token.fontWeight) as TextStyle["fontWeight"]),
    includeFontPadding: false,
  };
}

/** Small caps labels: three quarters of a caption, bold, tracked out. */
const LABEL = { size: 9, lineHeight: 11, tracking: 1.1 } as const;
const HELLO_TRACKING = 0.5;
const NAME_TYPE = { size: 28, lineHeight: 31 } as const;
const NAME_LINES = 2;
/** The name's floor as it shrinks to fit two lines (iOS: Android's native fit has no floor). */
const NAME_MIN_SCALE = 0.6;
/** The ascender space above the capitals, as a fraction of the font size: lifted off, the name's
 * capitals sit level with the photo plate's top edge. */
const NAME_CAP_GAP = 0.2;
const PLACE_GAP = 6;
const PHONE_GAP = 2;
/** The phone line's floor as it shrinks to keep the whole number on one line. */
const PHONE_MIN_SCALE = 0.7;
const CODE_TYPE = { size: 22, lineHeight: 28, tracking: 2.6 } as const;
const BADGE_TYPE = { size: 10, lineHeight: 12, tracking: 1.6 } as const;
const MICRO_TYPE = { size: 3.6, lineHeight: 4, tracking: 0.35 } as const;
/** "JOHN GOT IT · " repeated past any card width, then clipped. */
const MICRO_REPEATS = 14;
/** The relief's depth: half a design dp, a pixel or so on a phone. */
const RELIEF_DEPTH = 0.5;
const WORDMARK_BAR = { width: 14, height: 2.5, gap: 3 } as const;
/** The seal follows the name at this fraction of its font size (VerifiedBadge's proportions). */
const SEAL_SCALE = 0.72;
const SEAL_GAP = 4;
const SEAL_CAP_DROP = 0.18;
/** U+2060 WORD JOINER: the seal never starts a line on its own. */
const WORD_JOINER = "⁠";
/**
 * Ends the relief's copy: invisible and unbreakable, so the copy lays out exactly as the ink, but
 * its string is not the ink's, and a search for the card's text finds the ink alone.
 */
const RELIEF_MARK = WORD_JOINER;
/** The empty photo: the silhouette's width in the well, and the viewfinder ticks in its corners. */
const SILHOUETTE_FRACTION = 0.6;
const TICK = { inset: 6, arm: 7 } as const;
/** The rosettes: under the name column's empty end on the front, beside the code on the back. */
const FRONT_ROSETTE = { cx: 268, cy: 116, radius: 50 } as const;
const BACK_ROSETTE = { cx: 262, cy: 100, radius: 40 } as const;
/** The magnetic band's fine lines, one every this many design units. */
const STRIPE_LINE_SPACING = 2;

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });
const VIEW_BOX = `0 0 ${ID_CARD_BASE_WIDTH} ${ID_CARD_BASE_HEIGHT}`;

// Drawn once: the print scales with each card through its view box.
const WAVES_PATH = guillochePath();
const FRONT_ROSETTE_PATH = rosettePath(FRONT_ROSETTE.cx, FRONT_ROSETTE.cy, FRONT_ROSETTE.radius);
const BACK_ROSETTE_PATH = rosettePath(BACK_ROSETTE.cx, BACK_ROSETTE.cy, BACK_ROSETTE.radius);
const STRIPE_LINES = Array.from(
  { length: Math.floor(ID_CARD_BASE.stripe.height / STRIPE_LINE_SPACING) },
  (_, i) => `M0 ${i * STRIPE_LINE_SPACING + 1}H${ID_CARD_BASE_WIDTH}`,
).join("");

const hidden = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

type FaceShell = { palette: Palette; unit: number; gradientId: string };

/** The plastic under each face: its base light, its bloom and its rim. Static. */
export function CardBase({ palette, gradientId }: Omit<FaceShell, "unit">) {
  const rim = ID_CARD_BASE.radius;
  return (
    <Svg {...hidden} pointerEvents="none" style={StyleSheet.absoluteFill} viewBox={VIEW_BOX}>
      <Defs>
        <LinearGradient id={`${gradientId}-base`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={palette.lit.color} stopOpacity={palette.lit.opacity} />
          <Stop offset="1" stopColor={palette.shade.color} stopOpacity={palette.shade.opacity} />
        </LinearGradient>
        <RadialGradient id={`${gradientId}-bloom`} cx="0.92" cy="0.08" r="0.7">
          <Stop offset="0" stopColor={palette.bloom.color} stopOpacity={palette.bloom.opacity} />
          <Stop offset="1" stopColor={palette.bloom.color} stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id={`${gradientId}-rim`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={palette.rimLit.color} stopOpacity={palette.rimLit.opacity} />
          <Stop offset="0.45" stopColor={palette.rimLit.color} stopOpacity={0} />
          <Stop offset="0.6" stopColor={palette.rimDark.color} stopOpacity={0} />
          <Stop
            offset="1"
            stopColor={palette.rimDark.color}
            stopOpacity={palette.rimDark.opacity}
          />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId}-base)`} />
      <Rect width="100%" height="100%" fill={`url(#${gradientId}-bloom)`} />
      <Rect
        x={0.5}
        y={0.5}
        width={ID_CARD_BASE_WIDTH - 1}
        height={ID_CARD_BASE_HEIGHT - 1}
        rx={rim - 0.5}
        fill="none"
        stroke={`url(#${gradientId}-rim)`}
        strokeWidth={1}
      />
    </Svg>
  );
}

/** The security print: guilloche waves and a rosette, hairline strokes in the card's print ink. */
function SecurityPrint({ palette, rosette }: { palette: Palette; rosette: string }) {
  return (
    <Svg
      {...hidden}
      style={StyleSheet.absoluteFill}
      viewBox={VIEW_BOX}
      preserveAspectRatio="xMidYMid slice"
    >
      <Path d={WAVES_PATH} stroke={palette.print} strokeWidth={0.5} fill="none" />
      <Path d={rosette} stroke={palette.rosette} strokeWidth={0.5} fill="none" />
    </Svg>
  );
}

/** The plastic's grain: a noise tile repeated at a few percent. */
function Grain({ opacity }: { opacity: number }) {
  return (
    <Image
      {...hidden}
      source={grainTile}
      resizeMode="repeat"
      style={[StyleSheet.absoluteFill, { opacity }]}
    />
  );
}

/** The sunk layer: the print and the grain, together under the laminate. */
function PrintLayer({
  palette,
  rosette,
  style,
  testID,
}: {
  palette: Palette;
  rosette: string;
  style?: MotionStyle;
  testID?: string;
}) {
  return (
    <Animated.View {...hidden} pointerEvents="none" style={[PRINT_FRAME, style]} testID={testID}>
      <SecurityPrint palette={palette} rosette={rosette} />
      <Grain opacity={palette.grain} />
    </Animated.View>
  );
}

/** The print runs a few dp past each edge so its parallax never shows a border. */
const PRINT_BLEED = 6;
const PRINT_FRAME: ViewStyle = {
  position: "absolute",
  top: -PRINT_BLEED,
  left: -PRINT_BLEED,
  right: -PRINT_BLEED,
  bottom: -PRINT_BLEED,
};

/**
 * The sheen covers one and a half cards (Android rasterizes an SVG view at its pixel size): a lean
 * slides it by a quarter of the card at most, and its transparent ends keep its edges unseen. At
 * rest it sits a sixth of the card right of center, so the band crosses the corner and the
 * rosette, not the name; the lean sweeps it over the rest.
 */
const SHEEN_FRAME: ViewStyle = {
  position: "absolute",
  left: "-9%",
  top: "-25%",
  width: "150%",
  height: "150%",
};

/** The specular band: a hot core in a soft halo, with a faint pearl fringe on its trailing side. */
function Sheen({
  palette,
  gradientId,
  style,
  testID,
}: {
  palette: Palette;
  gradientId: string;
  style?: MotionStyle;
  testID?: string;
}) {
  const id = `${gradientId}-sheen`;
  return (
    <Animated.View {...hidden} pointerEvents="none" style={[SHEEN_FRAME, style]} testID={testID}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0.38" stopColor={palette.sheen} stopOpacity={0} />
            <Stop
              offset="0.45"
              stopColor={palette.sheen}
              stopOpacity={palette.sheenOpacity * 0.3}
            />
            <Stop
              offset="0.48"
              stopColor={palette.sheen}
              stopOpacity={palette.sheenOpacity * 0.85}
            />
            <Stop offset="0.5" stopColor={palette.sheen} stopOpacity={palette.sheenOpacity} />
            <Stop
              offset="0.52"
              stopColor={palette.sheen}
              stopOpacity={palette.sheenOpacity * 0.4}
            />
            {/* Offsets only grow: react-native-svg sorts stops, one out of order cuts the falloff. */}
            <Stop offset="0.56" stopColor={palette.fringe.color} stopOpacity={0} />
            <Stop
              offset="0.6"
              stopColor={palette.fringe.color}
              stopOpacity={palette.fringe.opacity}
            />
            <Stop offset="0.68" stopColor={palette.fringe.color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

/** How far the foil's gradient reaches past its band on each side, as a multiple of the band. */
const FOIL_SPAN = 3;

/**
 * Lime foil: a metallic gradient with brushed lines, three times as wide as its band so a tilt can
 * slide its bright streak across (`style` moves it; still renders leave it centered).
 */
function Foil({
  width,
  height,
  gradientId,
  style,
}: {
  width: number;
  height: number;
  gradientId: string;
  style?: MotionStyle;
}) {
  const id = `${gradientId}-foil`;
  const span = width * FOIL_SPAN;
  const lines = Array.from(
    { length: Math.ceil(height / 2) },
    (_, i) => `M0 ${i * 2 + 0.5}H${span}`,
  ).join("");
  return (
    <Animated.View
      {...hidden}
      pointerEvents="none"
      style={[{ position: "absolute", top: 0, left: -width, width: span, height }, style]}
    >
      <Svg width={span} height={height}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0.15">
            <Stop offset="0" stopColor={tokens.colors["green-500"]} />
            <Stop offset="0.36" stopColor={tokens.colors["green-500"]} />
            <Stop offset="0.46" stopColor={tokens.colors.white} stopOpacity={0.92} />
            <Stop offset="0.5" stopColor={tokens.colors.white} />
            <Stop offset="0.54" stopColor={tokens.colors.white} stopOpacity={0.92} />
            <Stop offset="0.64" stopColor={tokens.colors["green-500"]} />
            <Stop offset="1" stopColor={tokens.colors["green-500"]} />
          </LinearGradient>
        </Defs>
        <Rect width={span} height={height} fill={tokens.colors["green-500"]} />
        <Rect width={span} height={height} fill={`url(#${id})`} />
        <Path d={lines} stroke={withOpacity("white", 0.16)} strokeWidth={0.5} />
      </Svg>
    </Animated.View>
  );
}

type EngravedProps = {
  children: ReactNode;
  /** The same children with the inline parts that take room but show nothing (the seal's place). */
  shadowChildren?: ReactNode;
  style: TextStyle;
  relief: Relief;
  unit: number;
  numberOfLines?: number;
  adjustsFontSizeToFit?: boolean;
  minimumFontScale?: number;
  testID?: string;
};

/**
 * Ink with relief: the text, a 1 dp edge under it (its text shadow) and a copy 1 dp above it
 * behind, so each glyph reads pressed into (pearl) or raised out of (green) the plastic. The copy
 * is the same text with the same fit, so it lies exactly under the glyphs; it is hidden from
 * assistive technology.
 */
function Engraved({
  children,
  shadowChildren,
  style,
  relief,
  unit,
  numberOfLines,
  adjustsFontSizeToFit,
  minimumFontScale,
  testID,
}: EngravedProps) {
  const fit = { numberOfLines, adjustsFontSizeToFit, minimumFontScale, allowFontScaling: false };
  const depth = RELIEF_DEPTH * unit;
  return (
    <View>
      <Text
        {...fit}
        {...hidden}
        style={[
          style,
          { position: "absolute", top: -depth, left: 0, right: 0, color: relief.above },
        ]}
      >
        {shadowChildren ?? children}
        {RELIEF_MARK}
      </Text>
      <Text
        {...fit}
        style={[
          style,
          {
            textShadowColor: relief.below,
            textShadowOffset: { width: 0, height: depth },
            // Android draws no text shadow at radius 0: the softest it draws, half a dp.
            textShadowRadius: depth / 2,
          },
        ]}
        testID={testID}
      >
        {children}
      </Text>
    </View>
  );
}

/** The verified seal inline after the name; `shown` false keeps its room only (the relief copy). */
function InlineSeal({
  size,
  color,
  shown,
  testID,
}: {
  size: number;
  color: string;
  shown: boolean;
  testID?: string;
}) {
  return (
    <>
      {WORD_JOINER}
      <View
        {...hidden}
        style={{ width: SEAL_GAP + size, height: size, paddingStart: SEAL_GAP }}
        testID={testID}
      >
        {shown ? (
          <Svg
            width={size}
            height={size}
            viewBox={`0 0 ${VERIFIED_SEAL_VIEW_BOX} ${VERIFIED_SEAL_VIEW_BOX}`}
            style={{ transform: [{ translateY: size * SEAL_CAP_DROP }] }}
          >
            <Path d={VERIFIED_SEAL_PATH} fill={color} fillRule="evenodd" />
          </Svg>
        ) : null}
      </View>
    </>
  );
}

/** Small caps: the locale's uppercase, bold and tracked out. */
function Label({ children, palette, unit }: { children: string; palette: Palette; unit: number }) {
  const { i18n } = useTranslation();
  return (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      style={[
        cardType("caption", unit, {
          size: LABEL.size,
          lineHeight: LABEL.lineHeight,
          weight: "700",
        }),
        { color: palette.label, letterSpacing: LABEL.tracking * unit },
      ]}
    >
      {children.toLocaleUpperCase(i18n.language)}
    </Text>
  );
}

/** "JOHN GOT IT · JOHN GOT IT · …": a line until you look closely, as on printed IDs. */
function Microtext({ palette, unit }: { palette: Palette; unit: number }) {
  const { t, i18n } = useTranslation();
  const line = `${t("idCard.brand").toLocaleUpperCase(i18n.language)} · `.repeat(MICRO_REPEATS);
  return (
    <Text
      {...hidden}
      allowFontScaling={false}
      numberOfLines={1}
      ellipsizeMode="clip"
      style={[
        cardType("caption", unit, {
          size: MICRO_TYPE.size,
          lineHeight: MICRO_TYPE.lineHeight,
          weight: "600",
        }),
        {
          position: "absolute",
          top: ID_CARD_BASE.rule.top * unit,
          left: ID_CARD_BASE.paddingX * unit,
          right: ID_CARD_BASE.paddingX * unit,
          color: palette.microtext,
          letterSpacing: MICRO_TYPE.tracking * unit,
        },
      ]}
    >
      {line}
    </Text>
  );
}

/** The brand: a short lime bar over "John Got It", as the app's launch screen sets it. */
function Wordmark({ palette, unit }: { palette: Palette; unit: number }) {
  const { t } = useTranslation();
  return (
    <View {...hidden} style={{ alignItems: "flex-end" }}>
      <View
        style={{
          width: WORDMARK_BAR.width * unit,
          height: WORDMARK_BAR.height * unit,
          borderRadius: tokens.radius.pill,
          backgroundColor: tokens.colors["green-500"],
          marginBottom: WORDMARK_BAR.gap * unit,
        }}
      />
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[
          cardType("caption", unit, { lineHeight: 14, weight: "800" }),
          { color: palette.ink },
        ]}
      >
        {t("idCard.brand")}
      </Text>
    </View>
  );
}

/** The footer row, over the microtext rule: a labeled value on the left, the wordmark on the right. */
function Footer({
  palette,
  unit,
  children,
}: {
  palette: Palette;
  unit: number;
  children: ReactNode;
}) {
  const { paddingX, footer } = ID_CARD_BASE;
  return (
    <>
      <Microtext palette={palette} unit={unit} />
      <View
        style={{
          position: "absolute",
          left: paddingX * unit,
          right: paddingX * unit,
          bottom: footer.bottom * unit,
          height: footer.height * unit,
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <View style={{ flexShrink: 1 }}>{children}</View>
        <Wordmark palette={palette} unit={unit} />
      </View>
    </>
  );
}

/** "Hello, I'm:" on the card's center line, between two hairlines (on the foil band for a pro). */
function Header({
  variant,
  palette,
  unit,
  gradientId,
  width,
  foil,
}: FaceShell & { variant: IdCardVariant; width: number; foil?: MotionStyle }) {
  const { t } = useTranslation();
  const { header, paddingX } = ID_CARD_BASE;
  const onFoil = variant === "pro";
  const ink = onFoil ? tokens.colors["navy-900"] : palette.label;
  const rule = onFoil ? withOpacity("navy-900", 0.3) : palette.hairline;
  const band = header.height * unit;
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: band,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: paddingX * unit,
        gap: header.ruleGap * unit,
      }}
    >
      {onFoil ? (
        <View {...hidden} style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
          <Foil width={width} height={band} gradientId={gradientId} style={foil} />
          <View style={[styles.bandEdge, { backgroundColor: withOpacity("navy-900", 0.35) }]} />
        </View>
      ) : null}
      <View style={[styles.rule, { backgroundColor: rule }]} />
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[
          cardType("caption", unit, { weight: onFoil ? "800" : "600" }),
          { color: ink, letterSpacing: HELLO_TRACKING * unit },
        ]}
      >
        {t("idCard.hello")}
      </Text>
      <View style={[styles.rule, { backgroundColor: rule }]} />
    </View>
  );
}

/** Four viewfinder corners inside an empty photo well: a photo goes here. */
function ViewfinderTicks({ color }: { color: string }) {
  const { width, height, ring, mat } = ID_CARD_BASE.photo;
  const w = width - (ring + mat) * 2;
  const h = height - (ring + mat) * 2;
  const { inset: i, arm: a } = TICK;
  const d = [
    `M${i} ${i + a}V${i}H${i + a}`,
    `M${w - i - a} ${i}H${w - i}V${i + a}`,
    `M${w - i} ${h - i - a}V${h - i}H${w - i - a}`,
    `M${i + a} ${h - i}H${i}V${h - i - a}`,
  ].join("");
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox={`0 0 ${w} ${h}`}>
      <Path d={d} stroke={color} strokeWidth={1} fill="none" strokeLinecap="round" />
    </Svg>
  );
}

/** The photo's inner shadow: the well's top and sides fall under the mat's edge. */
function InnerShadow({ gradientId }: { gradientId: string }) {
  const shade = tokens.colors["navy-900"];
  return (
    <Svg {...hidden} pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={`${gradientId}-in-top`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={shade} stopOpacity={0.3} />
          <Stop offset="0.12" stopColor={shade} stopOpacity={0} />
          <Stop offset="0.9" stopColor={shade} stopOpacity={0} />
          <Stop offset="1" stopColor={shade} stopOpacity={0.12} />
        </LinearGradient>
        <LinearGradient id={`${gradientId}-in-side`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={shade} stopOpacity={0.16} />
          <Stop offset="0.1" stopColor={shade} stopOpacity={0} />
          <Stop offset="0.9" stopColor={shade} stopOpacity={0} />
          <Stop offset="1" stopColor={shade} stopOpacity={0.16} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId}-in-top)`} />
      <Rect width="100%" height="100%" fill={`url(#${gradientId}-in-side)`} />
    </Svg>
  );
}

type PhotoPlateProps = FaceShell & {
  photoUri?: string;
  onPhotoLoadEnd?: () => void;
  testID?: string;
};

/** The framed portrait: a ring (navy, lime for a pro), a mat in the card's color, a sunk well. */
function PhotoPlate({
  palette,
  unit,
  gradientId,
  photoUri,
  onPhotoLoadEnd,
  testID,
}: PhotoPlateProps) {
  const { photo, paddingX, bodyTop } = ID_CARD_BASE;
  const silhouette = Math.round(
    (photo.width - (photo.ring + photo.mat) * 2) * unit * SILHOUETTE_FRACTION,
  );
  return (
    <View
      style={[
        {
          position: "absolute",
          left: paddingX * unit,
          top: bodyTop * unit,
          width: photo.width * unit,
          height: photo.height * unit,
          borderRadius: photo.radius * unit,
          padding: photo.ring * unit,
          backgroundColor: palette.ring,
        },
        continuousCorners,
      ]}
      testID={testID ? `${testID}-plate` : undefined}
    >
      <View
        style={[
          {
            flex: 1,
            borderRadius: (photo.radius - photo.ring) * unit,
            padding: photo.mat * unit,
            backgroundColor: palette.surface,
          },
          continuousCorners,
        ]}
      >
        <View
          style={[
            {
              flex: 1,
              borderRadius: (photo.radius - photo.ring - photo.mat) * unit,
              backgroundColor: palette.well,
              overflow: "hidden",
              alignItems: "center",
              justifyContent: "flex-end",
            },
            continuousCorners,
          ]}
        >
          <ViewfinderTicks color={palette.hairline} />
          <Svg
            width={silhouette}
            height={silhouette}
            viewBox={`0 0 ${SILHOUETTE_VIEW_BOX} ${SILHOUETTE_VIEW_BOX}`}
            // Overlaps the well's bottom by a hair: the silhouette's flat base never shows a seam.
            style={{ marginBottom: -1 }}
          >
            <Path d={SILHOUETTE_PATH} fill={palette.silhouette} />
          </Svg>
          {photoUri ? (
            <Image
              // One native image per URI: a late end from the previous photo never reaches this one.
              key={photoUri}
              source={{ uri: photoUri }}
              resizeMode="cover"
              onLoadEnd={onPhotoLoadEnd}
              style={StyleSheet.absoluteFill}
              testID={testID ? `${testID}-photo` : undefined}
            />
          ) : null}
          <InnerShadow gradientId={gradientId} />
        </View>
      </View>
    </View>
  );
}

/** PRO in lime foil, straddling the photo plate's bottom edge. */
function ProBadge({
  unit,
  gradientId,
  foil,
  testID,
}: {
  unit: number;
  gradientId: string;
  foil?: MotionStyle;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { photo, paddingX, bodyTop, proBadge } = ID_CARD_BASE;
  const height = proBadge.height * unit;
  // Wide enough for "PRO" in any language this card speaks; centered under the plate.
  const width = photo.width * unit * proBadge.width;
  return (
    <View
      style={[
        {
          position: "absolute",
          left: (paddingX + photo.width / 2) * unit - width / 2,
          top: (bodyTop + photo.height) * unit - height / 2,
          width,
          height,
        },
      ]}
      testID={testID}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            top: unit,
            borderRadius: tokens.radius.pill,
            backgroundColor: withOpacity("navy-900", 0.35),
          },
        ]}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: tokens.radius.pill,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: withOpacity("white", 0.7),
          },
        ]}
      >
        <Foil width={width} height={height} gradientId={`${gradientId}-badge`} style={foil} />
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[
            cardType("caption", unit, {
              size: BADGE_TYPE.size,
              lineHeight: BADGE_TYPE.lineHeight,
              weight: "800",
            }),
            {
              color: tokens.colors["navy-900"],
              letterSpacing: BADGE_TYPE.tracking * unit,
              textShadowColor: withOpacity("white", 0.6),
              textShadowOffset: { width: 0, height: RELIEF_DEPTH * unit },
              textShadowRadius: (RELIEF_DEPTH * unit) / 2,
            },
          ]}
        >
          {t("idCard.pro")}
        </Text>
      </View>
    </View>
  );
}

type FrontProps = {
  variant: IdCardVariant;
  palette: Palette;
  unit: number;
  width: number;
  gradientId: string;
  name: string;
  place: string;
  phone?: string;
  photoUri?: string;
  verified: boolean;
  memberSince?: string;
  motion: FaceMotion;
  onPhotoLoadEnd?: () => void;
  testID?: string;
};

/**
 * The front, on its layers: the sunk print, the photo plate, the ink (header, name column and
 * footer), the PRO badge above the plate, and the light over all of it.
 */
export function Front({
  variant,
  palette,
  unit,
  width,
  gradientId,
  name,
  place,
  phone,
  photoUri,
  verified,
  memberSince,
  motion,
  onPhotoLoadEnd,
  testID,
}: FrontProps) {
  const { t } = useTranslation();
  const { paddingX, bodyTop, columnGap, photo } = ID_CARD_BASE;
  const nameType = cardType("title-1", unit, NAME_TYPE);
  const sealSize = Math.round(NAME_TYPE.size * unit * SEAL_SCALE);
  const sealed = (shown: boolean) =>
    verified ? (
      <InlineSeal
        size={sealSize}
        color={palette.seal}
        shown={shown}
        testID={shown && testID ? `${testID}-seal` : undefined}
      />
    ) : null;
  const shell = { palette, unit, gradientId };

  return (
    <>
      <PrintLayer
        palette={palette}
        rosette={FRONT_ROSETTE_PATH}
        style={motion.print}
        testID={testID ? `${testID}-front-print` : undefined}
      />
      <Animated.View
        style={[StyleSheet.absoluteFill, motion.ink]}
        testID={testID ? `${testID}-front-ink` : undefined}
      >
        <PhotoPlate
          {...shell}
          photoUri={photoUri}
          onPhotoLoadEnd={onPhotoLoadEnd}
          testID={testID}
        />
        {variant === "pro" ? (
          <ProBadge
            unit={unit}
            gradientId={gradientId}
            foil={motion.badgeFoil}
            testID={testID ? `${testID}-badge` : undefined}
          />
        ) : null}
        <Header {...shell} variant={variant} width={width} foil={motion.foil} />
        <View
          style={{
            position: "absolute",
            top: bodyTop * unit,
            left: (paddingX + photo.width + columnGap) * unit,
            right: paddingX * unit,
          }}
        >
          <View style={{ marginTop: -(nameType.fontSize ?? 0) * NAME_CAP_GAP }}>
            <Engraved
              style={{ ...nameType, color: palette.ink }}
              relief={palette.relief}
              unit={unit}
              numberOfLines={NAME_LINES}
              adjustsFontSizeToFit
              minimumFontScale={NAME_MIN_SCALE}
              shadowChildren={
                <>
                  {name}
                  {sealed(false)}
                </>
              }
              testID={testID ? `${testID}-name` : undefined}
            >
              {name}
              {sealed(true)}
            </Engraved>
          </View>
          {place ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[
                cardType("callout", unit),
                { color: palette.muted, marginTop: PLACE_GAP * unit },
              ]}
            >
              {place}
            </Text>
          ) : null}
          {phone ? (
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              // A number cut short is a wrong number: it shrinks to fit instead.
              adjustsFontSizeToFit
              minimumFontScale={PHONE_MIN_SCALE}
              style={[
                cardType("footnote", unit),
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
        <Footer palette={palette} unit={unit}>
          {memberSince ? (
            <>
              <Label palette={palette} unit={unit}>
                {t("idCard.memberSince")}
              </Label>
              <Text
                allowFontScaling={false}
                numberOfLines={1}
                style={[
                  cardType("footnote", unit, { lineHeight: 15, weight: "600" }),
                  { color: palette.ink },
                ]}
              >
                {memberSince}
              </Text>
            </>
          ) : null}
        </Footer>
      </Animated.View>
      <Sheen
        palette={palette}
        gradientId={gradientId}
        style={motion.sheen}
        testID={testID ? `${testID}-front-sheen` : undefined}
      />
    </>
  );
}

type BackProps = {
  palette: Palette;
  unit: number;
  gradientId: string;
  publicCode?: string;
  motion: FaceMotion;
  testID?: string;
};

/** The magnetic band: navy with a soft lit middle and fine lines. Decorative: it stores nothing. */
function Stripe({
  palette,
  unit,
  gradientId,
}: {
  palette: Palette;
  unit: number;
  gradientId: string;
}) {
  const { stripe } = ID_CARD_BASE;
  const id = `${gradientId}-stripe`;
  return (
    <View
      {...hidden}
      style={{
        position: "absolute",
        top: stripe.top * unit,
        left: 0,
        right: 0,
        height: stripe.height * unit,
        backgroundColor: palette.stripe,
      }}
    >
      <Svg
        style={StyleSheet.absoluteFill}
        viewBox={`0 0 ${ID_CARD_BASE_WIDTH} ${stripe.height}`}
        preserveAspectRatio="none"
      >
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tokens.colors.white} stopOpacity={0} />
            <Stop offset="0.35" stopColor={tokens.colors.white} stopOpacity={0.12} />
            <Stop offset="1" stopColor={tokens.colors.white} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
        <Path d={STRIPE_LINES} stroke={withOpacity("white", 0.05)} strokeWidth={0.5} />
      </Svg>
    </View>
  );
}

/** The decorative bar strip under the code: a barcode's look, no data in it. */
function Bars({ code, palette, unit }: { code: string; palette: Palette; unit: number }) {
  const { barsWidth, barsHeight } = ID_CARD_BASE.code;
  const bars = decorativeBars(code, barsWidth);
  return (
    <Svg
      {...hidden}
      width={barsWidth * unit}
      height={barsHeight * unit}
      viewBox={`0 0 ${barsWidth} ${barsHeight}`}
      style={{ marginTop: 8 * unit }}
    >
      <G fill={palette.ink} opacity={0.72}>
        {bars.map((bar) => (
          <Rect key={bar.x} x={bar.x} width={bar.width} height={barsHeight} />
        ))}
      </G>
    </Svg>
  );
}

/** The back: the band, the engraved code with its label and bars, the support line, the brand. */
export function Back({ palette, unit, gradientId, publicCode, motion, testID }: BackProps) {
  const { t } = useTranslation();
  const { paddingX, code } = ID_CARD_BASE;
  const grouped = publicCode ? formatPublicCode(publicCode) : "";
  return (
    <>
      <PrintLayer
        palette={palette}
        rosette={BACK_ROSETTE_PATH}
        style={motion.print}
        testID={testID ? `${testID}-back-print` : undefined}
      />
      <Stripe palette={palette} unit={unit} gradientId={gradientId} />
      <Animated.View
        style={[StyleSheet.absoluteFill, motion.ink]}
        testID={testID ? `${testID}-back-ink` : undefined}
      >
        {grouped ? (
          <View style={{ position: "absolute", top: code.top * unit, left: paddingX * unit }}>
            <Label palette={palette} unit={unit}>
              {t("idCard.code")}
            </Label>
            <View style={{ marginTop: 4 * unit }}>
              <Engraved
                style={{
                  ...cardType("title-2", unit, {
                    size: CODE_TYPE.size,
                    lineHeight: CODE_TYPE.lineHeight,
                    weight: "700",
                  }),
                  color: palette.ink,
                  fontFamily: MONOSPACE,
                  letterSpacing: CODE_TYPE.tracking * unit,
                }}
                relief={palette.relief}
                unit={unit}
                numberOfLines={1}
                testID={testID ? `${testID}-code` : undefined}
              >
                {grouped}
              </Engraved>
            </View>
            <Bars code={grouped} palette={palette} unit={unit} />
          </View>
        ) : null}
        <Footer palette={palette} unit={unit}>
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[cardType("caption", unit, { weight: "600" }), { color: palette.muted }]}
          >
            {t("idCard.support")}
          </Text>
        </Footer>
      </Animated.View>
      <Sheen palette={palette} gradientId={`${gradientId}-b`} style={motion.sheen} />
    </>
  );
}

const styles = StyleSheet.create({
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  bandEdge: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
});
