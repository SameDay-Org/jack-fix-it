import { View } from "react-native";

import { CategoryIcon } from "@/components/icons";
import { continuousCorners, tokens, withOpacity, type Radius } from "@/theme";

export type IconTileSize = "md" | "lg";

export type IconTileProps = {
  /** The category slug; a slug without a glyph shows the generic mark, so a grid never shifts or shows a hole. */
  slug: string;
  size?: IconTileSize;
  testID?: string;
};

/**
 * The two icon sizes the glyphs are drawn for, each centered with a margin on the 4-pt grid (12 and
 * 16 dp), and the radius token that keeps the squircle in step with the tile. Exported so a
 * placeholder can reserve exactly a tile's footprint.
 */
export const ICON_TILE: Record<IconTileSize, { side: number; icon: number; radius: Radius }> = {
  md: { side: 56, icon: 32, radius: "md" },
  lg: { side: 80, icon: 48, radius: "lg" },
};

// A faint green-500 wash: a tile that reads on a white card and on the gray-50 page, keeps the navy
// strokes far above 3:1, and echoes the brand accent without competing with the CTA.
const TINT_OPACITY = 0.12;
/** The tiles' wash, for a mark that must match them (History's empty state). */
export const ICON_TILE_TINT = withOpacity("green-500", TINT_OPACITY);

/** A category icon centered in a squircle tile. Decorative: the card around it names the category. */
export function IconTile({ slug, size = "md", testID }: IconTileProps) {
  const tile = ICON_TILE[size];

  return (
    <View
      testID={testID}
      className="items-center justify-center"
      style={[
        continuousCorners,
        {
          width: tile.side,
          height: tile.side,
          borderRadius: tokens.radius[tile.radius],
          backgroundColor: ICON_TILE_TINT,
        },
      ]}
    >
      <CategoryIcon slug={slug} size={tile.icon} fallback />
    </View>
  );
}
