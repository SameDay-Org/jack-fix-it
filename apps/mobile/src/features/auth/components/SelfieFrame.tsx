import { CameraView } from "expo-camera";
import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Ellipse, Path } from "react-native-svg";

import { SILHOUETTE_PATH, SILHOUETTE_VIEW_BOX } from "@/components/icons";
import { Button, ID_CARD_BASE, Notice, ProgressRing } from "@/components/ui";
import { continuousCorners, withOpacity } from "@/theme";

import type { PhotoStep } from "../usePhotoStep";

/**
 * The frame's width in dp: the card's 4:5 photo, large enough to frame a face and small enough
 * that the card, the frame and the action fit together on most phones.
 */
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = (FRAME_WIDTH * ID_CARD_BASE.photo.height) / ID_CARD_BASE.photo.width;
/**
 * The face guide: an oval where a face sits at arm's length, a little above the middle, as
 * fractions of the frame (its center and radii).
 */
const GUIDE = { cx: 0.5, cy: 0.46, rx: 0.32, ry: 0.34 } as const;
const GUIDE_STROKE = 2;
const GUIDE_COLOR = withOpacity("white", 0.85);
/** A soft dark line under the white one, so the guide reads over a bright scene too. */
const GUIDE_SHADOW_STROKE = 4;
const GUIDE_SHADOW_COLOR = withOpacity("navy-900", 0.3);
/** The placeholder before the camera is on, as the card draws its empty photo. */
const SILHOUETTE_SIZE = FRAME_WIDTH / 2;
const SILHOUETTE_COLOR = withOpacity("white", 0.4);
/** The scrim under the upload ring, so the white arc reads over any photo. */
const SCRIM = withOpacity("navy-900", 0.55);
const RING_SIZE = 56;

export type SelfieFrameProps = {
  photo: Omit<PhotoStep, "camera">;
  /** The live preview, for the capture (the hook's `camera`). */
  camera: RefObject<CameraView | null>;
  /**
   * The step is the one on screen and its screen is in front (focused): the preview is mounted
   * only then.
   */
  active: boolean;
  testID?: string;
};

/**
 * The selfie step's body (#294): a portrait frame in the card photo's proportions, showing the
 * live front camera with a face guide, the photo to use (under an upload ring while it is saved),
 * or a quiet silhouette before the camera is on. Under it: why the camera is off, and the way
 * around it (the photo library), or Retake once there is a photo.
 */
export function SelfieFrame({ photo, camera, active, testID }: SelfieFrameProps) {
  const { t } = useTranslation();
  const { mode, photoUri, progress, preview, onCameraStop } = photo;

  // Leaving the step, or another screen covering this one, releases its preview at once, on both
  // platforms (`active={false}` only pauses it on iOS): the pane shows the placeholder. A later visit mounts a new
  // preview, which has to report ready itself. Not on the preview's own unmount, which a camera
  // that failed to start goes through too.
  useEffect(() => {
    if (!active) onCameraStop();
  }, [active, onCameraStop]);

  return (
    <View className="items-center gap-4" testID={testID}>
      <View
        className="overflow-hidden rounded-lg bg-navy-900"
        style={[{ width: FRAME_WIDTH, height: FRAME_HEIGHT }, continuousCorners]}
      >
        {mode === "review" && photoUri ? (
          <Image
            // One native image per photo: a late load from the previous one never shows here.
            key={photoUri}
            source={{ uri: photoUri }}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t("signUp.photo.yours")}
            testID={testID ? `${testID}-photo` : undefined}
          />
        ) : mode === "camera" && active ? (
          <>
            <CameraView
              key={preview.id}
              ref={camera}
              facing="front"
              onCameraReady={preview.onReady}
              onMountError={preview.onError}
              style={StyleSheet.absoluteFill}
              accessibilityLabel={t("signUp.photo.preview")}
              testID={testID ? `${testID}-camera` : undefined}
            />
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={StyleSheet.absoluteFill}
            >
              <Svg width={FRAME_WIDTH} height={FRAME_HEIGHT}>
                {[
                  { color: GUIDE_SHADOW_COLOR, width: GUIDE_SHADOW_STROKE },
                  { color: GUIDE_COLOR, width: GUIDE_STROKE },
                ].map((line) => (
                  <Ellipse
                    key={line.color}
                    cx={GUIDE.cx * FRAME_WIDTH}
                    cy={GUIDE.cy * FRAME_HEIGHT}
                    rx={GUIDE.rx * FRAME_WIDTH}
                    ry={GUIDE.ry * FRAME_HEIGHT}
                    stroke={line.color}
                    strokeWidth={line.width}
                    fill="none"
                  />
                ))}
              </Svg>
            </View>
          </>
        ) : (
          <View
            className="flex-1 items-center justify-end"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Svg
              width={SILHOUETTE_SIZE}
              height={SILHOUETTE_SIZE}
              viewBox={`0 0 ${SILHOUETTE_VIEW_BOX} ${SILHOUETTE_VIEW_BOX}`}
            >
              <Path d={SILHOUETTE_PATH} fill={SILHOUETTE_COLOR} />
            </Svg>
          </View>
        )}
        {progress !== null ? (
          <View
            className="items-center justify-center"
            style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM }]}
          >
            <ProgressRing
              progress={progress}
              size={RING_SIZE}
              accessibilityLabel={t("signUp.photo.uploading")}
              testID={testID ? `${testID}-progress` : undefined}
            />
          </View>
        ) : null}
      </View>
      {mode === "blocked" ? (
        <Notice
          tone="info"
          title={t("signUp.photo.blockedTitle")}
          body={t("signUp.photo.blockedBody")}
          className="self-stretch"
          testID={testID ? `${testID}-blocked` : undefined}
        />
      ) : null}
      {mode === "unavailable" ? (
        <Notice
          tone="info"
          title={t("signUp.photo.unavailableTitle")}
          body={t("signUp.photo.unavailableBody")}
          className="self-stretch"
          testID={testID ? `${testID}-unavailable` : undefined}
        />
      ) : null}
      {mode === "review" ? (
        <Button
          label={t("signUp.photo.retake")}
          variant="ghost"
          disabled={photo.submitting}
          onPress={photo.retake}
          testID={testID ? `${testID}-retake` : undefined}
        />
      ) : photo.offersLibrary ? (
        <Button
          label={t("signUp.photo.library")}
          variant="ghost"
          disabled={photo.capturing}
          onPress={photo.pickFromLibrary}
          testID={testID ? `${testID}-library` : undefined}
        />
      ) : null}
    </View>
  );
}
