import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { ControlIcon } from "@/components/icons";
import { useFlag } from "@/components/ui";
import { mediaExpired } from "@/features/opportunities/useOpportunity";
import { continuousCorners, pressedTransform, tokens, withOpacity } from "@/theme";

import { SHEET_OVERLAP } from "./JobChrome";
import { JobPhotos } from "./JobPhotos";
import type { CustomerJob } from "./phase";

export type JobPhoto = CustomerJob["photos"]["after"][number];

// The photo hero: the screen's width at 4:3, never taller than this.
const HERO_RATIO = 3 / 4;
const HERO_MAX_HEIGHT = 360;
// The page count sits this far above the sheet's rounded top.
const COUNT_GAP = 12;
const GLYPH = 32;
// The frame glyph over the navy hero: light, but quieter than the text.
const FRAME_ON_DARK = 0.6;
const THUMB = 72;
const RIPPLE_OPACITY = 0.15;
const RIPPLE = { color: withOpacity("white", RIPPLE_OPACITY), foreground: true };
const THUMB_RIPPLE = { color: withOpacity("navy-900", RIPPLE_OPACITY), foreground: true };

// The after photos have their own place on these screens: none in the section below them.
const NO_PHOTOS: JobPhoto[] = [];

type BeforePhotosProps = {
  photos: CustomerJob["photos"];
  updatedAt: number;
  /** Asks for the job again: an expired URL comes back fresh. */
  refetch: () => Promise<unknown>;
};

/**
 * The job's photos section (`JobPhotos`, #342) on the finished and confirmed screens, which show
 * the after photos above it: the before ones, and how many are still being prepared.
 */
export function BeforePhotos({ photos, updatedAt, refetch }: BeforePhotosProps) {
  return (
    <JobPhotos
      photos={{ before: photos.before, after: NO_PHOTOS, pending: photos.pending }}
      updatedAt={updatedAt}
      refetch={refetch}
    />
  );
}

/** The hero's size on this screen: the full width, 4:3, capped. */
export function usePhotoHeroSize(): { width: number; height: number } {
  const { width } = useWindowDimensions();
  return { width, height: Math.min(HERO_MAX_HEIGHT, width * HERO_RATIO) };
}

/** The photo, or a quiet frame where it cannot be shown (its URL expired, or it did not load). */
export function PhotoImage({
  photo,
  now,
  fit,
  tone,
  testID,
}: {
  photo: JobPhoto;
  now: number;
  fit: "cover" | "contain";
  /** The surface the frame sits on: the glyph stays readable on both. */
  tone: "dark" | "light";
  testID: string;
}) {
  // Keyed by URL: a fresh URL (a refetch after expiry) is a new image, so one that failed loads again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const shown = !mediaExpired(photo, now) && failedUrl !== photo.url;
  if (!shown) {
    return (
      <View className="flex-1 items-center justify-center" testID={`${testID}-frame`}>
        <ControlIcon
          name="photo"
          size={GLYPH}
          color={tone === "dark" ? withOpacity("white", FRAME_ON_DARK) : tokens.colors["gray-500"]}
        />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: photo.url }}
      style={StyleSheet.absoluteFill}
      resizeMode={fit}
      onError={() => setFailedUrl(photo.url)}
      accessibilityIgnoresInvertColors
      testID={`${testID}-image`}
    />
  );
}

type PhotoHeroProps = {
  photos: readonly JobPhoto[];
  /** The time the photos are drawn at: an expired URL shows the frame, never a broken image. */
  now: number;
  /** Opens the photos full screen at this one. */
  onOpen: (index: number) => void;
};

/**
 * The pro's after photos as the screen's hero, edge to edge: one page per photo, swiped through,
 * with "2 of 3" over the corner when there are several. Each page is a button that opens the photo
 * full screen, named for screen readers ("Photo of the finished work, 2 of 3").
 */
export function PhotoHero({ photos, now, onOpen }: PhotoHeroProps) {
  const { t } = useTranslation();
  const { width, height } = usePhotoHeroSize();
  const [page, setPage] = useState(0);

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    setPage(Math.min(photos.length - 1, Math.max(0, next)));
  };

  return (
    <View className="bg-navy-900" style={{ width, height }} testID="job-photo-hero">
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        testID="job-photo-hero-pages"
      >
        {photos.map((photo, index) => (
          <HeroPage
            key={photo.id}
            photo={photo}
            now={now}
            width={width}
            height={height}
            label={t("jobs.afterPhotos.photo", { number: index + 1, total: photos.length })}
            onPress={() => onOpen(index)}
            testID={`job-photo-hero-${index}`}
          />
        ))}
      </ScrollView>
      {photos.length > 1 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="absolute right-4 rounded-pill bg-navy-900/70 px-3 py-1"
          style={{ bottom: SHEET_OVERLAP + COUNT_GAP }}
          testID="job-photo-hero-count"
        >
          <Text className="text-footnote font-semibold text-white">
            {t("jobs.afterPhotos.page", { number: page + 1, total: photos.length })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

type HeroPageProps = {
  photo: JobPhoto;
  now: number;
  width: number;
  height: number;
  label: string;
  onPress: () => void;
  testID: string;
};

function HeroPage({ photo, now, width, height, label, onPress, testID }: HeroPageProps) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint={t("jobs.afterPhotos.openHint")}
      onPress={onPress}
      android_ripple={RIPPLE}
      style={{ width, height }}
      testID={testID}
    >
      <PhotoImage photo={photo} now={now} fit="cover" tone="dark" testID={testID} />
    </Pressable>
  );
}

type PhotoThumbsProps = {
  photos: readonly JobPhoto[];
  now: number;
  onOpen: (index: number) => void;
};

/** The after photos as a row of small rounded tiles under a title, each opening it full screen. */
export function PhotoThumbs({ photos, now, onOpen }: PhotoThumbsProps) {
  const { t } = useTranslation();
  if (photos.length === 0) return null;
  return (
    <View className="gap-3" testID="job-photo-thumbs">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {t("jobs.afterPhotos.title")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {photos.map((photo, index) => (
          <Thumb
            key={photo.id}
            photo={photo}
            now={now}
            label={t("jobs.afterPhotos.photo", { number: index + 1, total: photos.length })}
            onPress={() => onOpen(index)}
            testID={`job-photo-thumb-${index}`}
          />
        ))}
      </View>
    </View>
  );
}

type ThumbProps = {
  photo: JobPhoto;
  now: number;
  label: string;
  onPress: () => void;
  testID: string;
};

function Thumb({ photo, now, label, onPress, testID }: ThumbProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint={t("jobs.afterPhotos.openHint")}
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      android_ripple={THUMB_RIPPLE}
      // A style, not a `scale-*` class: a transform class that appears on press remounts the view.
      style={[continuousCorners, { width: THUMB, height: THUMB }, pressed && pressedTransform]}
      className="overflow-hidden rounded-md bg-navy-900/10"
      testID={testID}
    >
      <PhotoImage photo={photo} now={now} fit="cover" tone="light" testID={testID} />
    </Pressable>
  );
}
