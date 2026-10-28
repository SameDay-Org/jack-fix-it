import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { continuousCorners, tokens } from "@/theme";

import { mediaExpired, type OpportunityMedia as MediaItem } from "./useOpportunity";

export type OpportunityMediaProps = {
  media: readonly MediaItem[];
  /** How many more photos and videos are still being prepared. */
  pending: number;
  /** The time the tiles are drawn at (see `useRefreshExpiredMedia`). */
  now: number;
  testID?: string;
};

/** Three tiles fit a 320 dp screen's content width with the kit's gap-2 between them. */
const TILE = { width: 80, height: 80 } as const;
const GLYPH_SIZE = 28;

/**
 * The request's photos and videos as a row of tiles, read as one group ("2 photos, 1 video, 2
 * more being prepared"). There is no viewer yet (post-MVP), so no tile is a control.
 */
export function OpportunityMedia({
  media,
  pending,
  now,
  testID = "opportunity-media",
}: OpportunityMediaProps) {
  const { t } = useTranslation();
  if (media.length === 0 && pending === 0) return null;

  const photos = media.filter((item) => item.kind === "photo").length;
  const videos = media.length - photos;
  const label = [
    photos > 0 ? t("opportunities.media.photos", { count: photos }) : null,
    videos > 0 ? t("opportunities.media.videos", { count: videos }) : null,
    pending > 0 ? t("opportunities.media.pending", { count: pending }) : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View className="gap-3" testID={testID}>
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("opportunities.media.title")}
      </Text>
      <View accessible accessibilityLabel={label} className="gap-2">
        {media.length > 0 ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="flex-row flex-wrap gap-2"
          >
            {media.map((item, index) => (
              <MediaTile
                key={item.url}
                item={item}
                expired={mediaExpired(item, now)}
                testID={`${testID}-${index}`}
              />
            ))}
          </View>
        ) : null}
        {pending > 0 ? (
          <Text className="text-footnote text-gray-500" testID={`${testID}-pending`}>
            {t("opportunities.media.pending", { count: pending })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

type MediaTileProps = {
  item: MediaItem;
  expired: boolean;
  testID: string;
};

/**
 * A photo as a thumbnail, a video as a navy tile with a play glyph. An expired or unloadable URL
 * shows a quiet frame instead, never a broken image; the detail refetches fresh URLs.
 */
function MediaTile({ item, expired, testID }: MediaTileProps) {
  const [failed, setFailed] = useState(false);
  const photo = item.kind === "photo" && !expired && !failed;
  const video = item.kind === "video" && !expired;

  return (
    <View
      style={[continuousCorners, TILE]}
      className={`items-center justify-center overflow-hidden rounded-md ${
        video ? "bg-navy-900" : "bg-navy-900/10"
      }`}
      testID={testID}
    >
      {photo ? (
        <Image
          source={{ uri: item.url }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
          testID={`${testID}-image`}
        />
      ) : null}
      {video ? <PlayGlyph /> : null}
      {!photo && !video ? <FrameGlyph /> : null}
    </View>
  );
}

function PlayGlyph() {
  return (
    <Svg width={GLYPH_SIZE} height={GLYPH_SIZE} viewBox="0 0 24 24" testID="media-play">
      <Circle cx={12} cy={12} r={11} fill={tokens.colors.white} />
      <Path d="M9.5 7.5v9l7.5-4.5z" fill={tokens.colors["navy-900"]} />
    </Svg>
  );
}

function FrameGlyph() {
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
