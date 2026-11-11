import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { continuousCorners, tokens } from "@/theme";

/** A photo the API serves from storage, at a URL signed until `expires_at`. */
export type RemotePhoto = { id: string; url: string; expires_at: string };

export type PhotoTilesProps = {
  photos: readonly RemotePhoto[];
  /** The time the tiles are drawn at: a URL past its expiry shows the frame, not a broken image. */
  now: number;
  /** Each tile's accessible name, e.g. "After photo 1 of 3". */
  label: (index: number, total: number) => string;
  testID: string;
};

/** Three tiles fit a 320 dp screen's content width with the kit's gap-2 between them. */
export const PHOTO_TILE = { width: 80, height: 80 } as const;
const GLYPH_SIZE = 28;

/**
 * Photos as a wrapping row of square tiles, each one an image for assistive technology with its
 * own name. There is no viewer yet (post-MVP), so no tile is a control.
 */
export function PhotoTiles({ photos, now, label, testID }: PhotoTilesProps) {
  return (
    <View className="flex-row flex-wrap gap-2" testID={testID}>
      {photos.map((photo, index) => (
        <PhotoTile
          // A fresh URL (a refetch after expiry) is a new tile, so an image that failed loads again.
          key={photo.url}
          url={photo.url}
          expired={Date.parse(photo.expires_at) <= now}
          label={label(index, photos.length)}
          testID={`${testID}-${index}`}
        />
      ))}
    </View>
  );
}

type PhotoTileProps = { url: string; expired: boolean; label: string; testID: string };

/** The photo, or a quiet frame when its URL expired or did not load: never a broken image. */
function PhotoTile({ url, expired, label, testID }: PhotoTileProps) {
  const [failed, setFailed] = useState(false);
  const shown = !expired && !failed;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={[continuousCorners, PHOTO_TILE]}
      className="items-center justify-center overflow-hidden rounded-md bg-navy-900/10"
      testID={testID}
    >
      {shown ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
          testID={`${testID}-image`}
        />
      ) : (
        <FrameGlyph />
      )}
    </View>
  );
}

/** A picture frame: where a photo would be when it cannot be shown. */
export function FrameGlyph() {
  const stroke = tokens.colors["gray-500"];
  return (
    <Svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      testID="media-frame"
    >
      <Rect x={3} y={5} width={18} height={14} rx={3} stroke={stroke} strokeWidth={1.5} />
      <Circle cx={8.5} cy={10} r={1.5} fill={stroke} />
      <Path
        d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
