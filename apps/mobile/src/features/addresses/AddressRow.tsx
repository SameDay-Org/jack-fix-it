import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ControlIcon, type Glyph } from "@/components/icons";
import { ListRowTile, StatusBadge, useFlag } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { tokens } from "@/theme";

import type { SavedAddress } from "./api";
import { addressLine } from "./addressFields";

/** The menu button's side: a 48 dp target, the row's own height at the smallest font. */
const MORE_SIDE = 48;
const MORE_ICON = 24;

export type AddressRowProps = {
  address: SavedAddress;
  /** The row's tile; named `glyph` so a `ListGroup` starts the separator past it. */
  glyph: Glyph;
  /** Opens the address to edit it. */
  onEdit: () => void;
  /** Opens its menu: Make default, Delete. */
  onMore: () => void;
};

/**
 * One address of the book, in a `ListGroup`: its name with the Default chip, the address on one
 * line (wrapping as it needs), and a note when its ZIP is outside the service areas. The row opens
 * the address to edit; the dots beside it open its menu. Two buttons side by side, so each is
 * reachable on its own with a screen reader.
 */
export function AddressRow({ address, glyph, onEdit, onMore }: AddressRowProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  const [morePressed, morePressIn, morePressOut] = useFlag();
  const line = addressLine(address);
  const spoken = [
    address.label,
    address.is_default ? t("addresses.default") : null,
    line,
    address.served ? null : t("addresses.notServed"),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View className="flex-row items-center pr-1" testID={`address-${address.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint={t("addresses.row.editHint")}
        onPress={onEdit}
        onPressIn={pressIn}
        onPressOut={pressOut}
        className={cx(
          "min-h-14 flex-1 flex-row items-center gap-3 py-3 pl-4 pr-2",
          pressed && "bg-navy-900/5",
        )}
        testID={`address-${address.id}-edit`}
      >
        <ListRowTile glyph={glyph} />
        <View className="flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text
              android_hyphenationFrequency="full"
              className="shrink text-body font-semibold text-navy-900"
            >
              {address.label}
            </Text>
            {address.is_default ? (
              <StatusBadge
                label={t("addresses.default")}
                tone="brand"
                testID={`address-${address.id}-default`}
              />
            ) : null}
          </View>
          <Text className="text-callout text-gray-500">{line}</Text>
          {address.served ? null : (
            <Text
              className="text-footnote text-navy-900"
              testID={`address-${address.id}-not-served`}
            >
              {t("addresses.notServed")}
            </Text>
          )}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("addresses.row.more", { label: address.label })}
        onPress={onMore}
        onPressIn={morePressIn}
        onPressOut={morePressOut}
        className={cx("items-center justify-center rounded-full", morePressed && "bg-navy-900/5")}
        style={{ width: MORE_SIDE, height: MORE_SIDE }}
        testID={`address-${address.id}-more`}
      >
        <ControlIcon name="more" filled size={MORE_ICON} color={tokens.colors["gray-500"]} />
      </Pressable>
    </View>
  );
}
