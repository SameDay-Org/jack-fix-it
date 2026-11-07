import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { CategoryIcon, ControlIcon, type Glyph } from "@/components/icons";
import { bubbleShadow, continuousCorners, tokens } from "@/theme";

import { cx } from "./cx";
import { ICON_TILE_TINT } from "./IconTile";
import { useFlag } from "./useFlag";

/** The row's icon tile and glyph, in dp; the tile's radius is the small token, its squircle. */
const TILE = { side: 40, icon: 24 } as const;
const CHEVRON = 20;
/** The separator starts where the label does: the row's `px-4`, then the tile and the `gap-3`. */
const ROW_PADDING = 16;
const SEPARATOR_INSET = ROW_PADDING + TILE.side + 12;

export type ListRowProps = {
  label: string;
  /** A glyph of the category drawing system, in a squircle tile on the left. */
  glyph?: Glyph;
  /** A second line under the label: the value of a setting. */
  value?: string;
  /** Makes the row a button. It opens its screen unless `chevron` is false (an action). */
  onPress?: () => void;
  /** The chevron of a row that opens a screen; on by default for a pressable row. */
  chevron?: boolean;
  /** A spinner in place of the chevron; presses are ignored meanwhile. */
  busy?: boolean;
  /** What the press does, when the label alone does not say it. */
  accessibilityHint?: string;
  /** Anything after the label column: a badge. */
  accessory?: ReactNode;
  testID?: string;
};

/**
 * One row of a settings-style list: an icon tile, the name (and its value), and a chevron when it
 * opens a screen. A pressable row is one button for assistive technology; a static one is text.
 * Rows sit in a `ListGroup`.
 */
export function ListRow({
  label,
  glyph,
  value,
  onPress,
  chevron = true,
  busy = false,
  accessibilityHint,
  accessory,
  testID,
}: ListRowProps) {
  const [pressed, pressIn, pressOut] = useFlag();

  const content = (
    <>
      {glyph ? (
        <View
          className="items-center justify-center rounded-sm"
          style={[
            continuousCorners,
            { width: TILE.side, height: TILE.side, backgroundColor: ICON_TILE_TINT },
          ]}
        >
          <CategoryIcon slug="" glyph={glyph} size={TILE.icon} />
        </View>
      ) : null}
      <View className="flex-1 gap-0.5">
        {/* A word longer than the line (Configuración at a large font) is hyphenated on Android
            rather than cut at any letter. */}
        <Text android_hyphenationFrequency="full" className="text-body text-navy-900">
          {label}
        </Text>
        {value ? (
          <Text android_hyphenationFrequency="full" className="text-callout text-gray-500">
            {value}
          </Text>
        ) : null}
      </View>
      {accessory}
      {busy ? (
        <ActivityIndicator
          color={tokens.colors["navy-900"]}
          testID={testID ? `${testID}-busy` : undefined}
        />
      ) : onPress && chevron ? (
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors["gray-500"]} />
      ) : null}
    </>
  );
  const row = "min-h-14 flex-row items-center gap-3 px-4 py-2";

  if (!onPress) {
    return (
      <View className={row} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      testID={testID}
      className={cx(row, pressed && "bg-navy-900/5")}
    >
      {content}
    </Pressable>
  );
}

type ListGroupProps = {
  children: ReactNode;
  className?: string;
  testID?: string;
};

/** A white bubble holding `ListRow`s, with a separator between rows from the label's edge. */
export function ListGroup({ children, className, testID }: ListGroupProps) {
  const rows = Children.toArray(children);
  // The shadow on the outer view, the clip on the inner one: iOS clips a shadow with its own view.
  return (
    <View
      className={cx("rounded-lg bg-white", className)}
      style={[bubbleShadow, continuousCorners]}
      testID={testID}
    >
      <View className="overflow-hidden rounded-lg" style={continuousCorners}>
        {rows.map((row, index) => (
          // Children.toArray keys every child, so the fragment carries the row's own key.
          <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
            {index > 0 ? (
              <View
                className="h-px bg-navy-900/10"
                style={{
                  // From the label's edge of the row below: past its tile, or the padding alone.
                  marginStart:
                    isValidElement<ListRowProps>(row) && row.props.glyph
                      ? SEPARATOR_INSET
                      : ROW_PADDING,
                }}
                testID={testID ? `${testID}-separator` : undefined}
              />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}
