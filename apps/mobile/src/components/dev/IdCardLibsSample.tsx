// Dev-only smoke screen content for the ID card libraries (#251), unreachable outside __DEV__: the
// sample strings are literal on purpose. One section per library, each proving it loads and runs.
import { CameraView, PermissionStatus, type CameraType } from "expo-camera";
import { useIsFocused } from "expo-router";
import { useState, type ReactNode, type RefObject } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import ViewShot, { type ViewShotRef } from "react-native-view-shot";

import { Button, Card, Notice, StatusBadge, type StatusTone } from "@/components/ui";
import { continuousCorners } from "@/theme";

import {
  CARD_CAPTURE_OPTIONS,
  useCameraAccess,
  useCardCapture,
  useGyroscopeReading,
  useHapticTaps,
  useShareSheet,
  type CardCapture,
} from "./useIdCardLibs";

// ID-1 card proportions (85.6 x 54 mm): the real card keeps them whatever the capture size.
const CARD_ASPECT = 85.6 / 54;
// The selfie frame: the front camera reports 4:3 on both platforms.
const PREVIEW_ASPECT = 3 / 4;
const GYRO_INTERVAL_MS = 100;

type Badge = { label: string; tone: StatusTone };

function Section({ title, badge, children }: { title: string; badge: Badge; children: ReactNode }) {
  return (
    <Card>
      <View className="gap-3">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="shrink text-headline text-navy-900">{title}</Text>
          <StatusBadge label={badge.label} tone={badge.tone} />
        </View>
        {children}
      </View>
    </Card>
  );
}

function CameraSection() {
  const { permission, requestPermission, openSettings } = useCameraAccess();
  const [facing, setFacing] = useState<CameraType>("front");
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const focused = useIsFocused();

  // An emulator may have one lens only: the other one proves the preview there.
  const flip = () => {
    setFacing((current) => (current === "front" ? "back" : "front"));
    setReady(false);
    setMountError(null);
  };

  if (!permission) {
    return (
      <Section title="Camera" badge={{ label: "Checking", tone: "neutral" }}>
        <Text className="text-callout text-gray-500">Asking whether Jack may use the camera.</Text>
      </Section>
    );
  }
  if (permission.granted) {
    const badge: Badge = mountError
      ? { label: "Failed", tone: "danger" }
      : ready
        ? { label: "Ready", tone: "success" }
        : { label: "Starting", tone: "info" };
    return (
      <Section title="Camera" badge={badge}>
        <View
          className="overflow-hidden rounded-lg bg-navy-900"
          style={[{ aspectRatio: PREVIEW_ASPECT }, continuousCorners]}
        >
          <CameraView
            facing={facing}
            active={focused}
            onCameraReady={() => setReady(true)}
            onMountError={(event) => setMountError(event.message)}
            style={StyleSheet.absoluteFill}
            accessibilityLabel={`${facing === "front" ? "Front" : "Back"} camera preview`}
            testID="camera-preview"
          />
        </View>
        {mountError ? (
          <Notice tone="danger" title="Camera could not start" body={mountError} />
        ) : null}
        <Text className="text-footnote text-gray-500">
          {facing === "front"
            ? "The front camera inside the screen: the selfie step's preview."
            : "The back camera, for a device without a front one."}
        </Text>
        <Button
          label={facing === "front" ? "Use the back camera" : "Use the front camera"}
          variant="ghost"
          onPress={flip}
        />
      </Section>
    );
  }
  if (permission.canAskAgain) {
    const denied = permission.status === PermissionStatus.DENIED;
    return (
      <Section
        title="Camera"
        badge={
          denied ? { label: "Denied", tone: "warning" } : { label: "Not asked", tone: "neutral" }
        }
      >
        <Text className="text-callout text-gray-500">
          The preview needs the camera. The system asks once.
        </Text>
        <Button label="Allow camera" variant="secondary" onPress={() => void requestPermission()} />
      </Section>
    );
  }
  return (
    <Section title="Camera" badge={{ label: "Off", tone: "danger" }}>
      <Notice
        tone="info"
        title="Camera access is off"
        body="Turn it on for Jack in Settings, then come back: the preview starts on its own."
      >
        <Button label="Open settings" variant="secondary" onPress={() => void openSettings()} />
      </Notice>
    </Section>
  );
}

function SampleCard() {
  return (
    <View className="flex-1 justify-between rounded-lg bg-navy-900 p-4" style={continuousCorners}>
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-headline text-white">Jack Fix It</Text>
        <View className="h-2 w-10 rounded-pill bg-green-500" />
      </View>
      <View className="gap-1">
        <Text className="text-title-2 text-white">Alex Morgan</Text>
        <Text className="text-footnote text-green-500">Member since 2026</Text>
      </View>
    </View>
  );
}

const CAPTURE_BADGE: Record<CardCapture["status"], Badge> = {
  idle: { label: "Not captured", tone: "neutral" },
  capturing: { label: "Capturing", tone: "info" },
  captured: { label: "PNG ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

type SnapshotSectionProps = {
  shot: RefObject<ViewShotRef | null>;
  capture: CardCapture;
  onCapture: () => void;
};

function SnapshotSection({ shot, capture, onCapture }: SnapshotSectionProps) {
  return (
    <Section title="Card snapshot" badge={CAPTURE_BADGE[capture.status]}>
      <ViewShot ref={shot} options={CARD_CAPTURE_OPTIONS} style={{ aspectRatio: CARD_ASPECT }}>
        <SampleCard />
      </ViewShot>
      <Button
        label="Capture PNG"
        variant="secondary"
        loading={capture.status === "capturing"}
        onPress={onCapture}
      />
      {capture.status === "captured" ? (
        <View className="gap-2">
          <Image
            source={{ uri: capture.uri }}
            className="w-full rounded-lg"
            style={{ aspectRatio: CARD_ASPECT }}
            accessibilityLabel="The captured card"
            testID="captured-card"
          />
          <Text className="text-footnote text-gray-500">{`${capture.width} x ${capture.height} px`}</Text>
        </View>
      ) : null}
      {capture.status === "failed" ? (
        <Notice tone="danger" title="Capture failed" body={capture.message} />
      ) : null}
    </Section>
  );
}

function ShareSection({ uri }: { uri: string | null }) {
  const { available, shares, error, share } = useShareSheet();
  const badge: Badge =
    available === null
      ? { label: "Checking", tone: "neutral" }
      : !available
        ? { label: error ? "Failed" : "Unavailable", tone: "danger" }
        : shares > 0
          ? { label: `Shared x${shares}`, tone: "success" }
          : { label: "Available", tone: "info" };

  return (
    <Section title="Share sheet" badge={badge}>
      <Text className="text-callout text-gray-500">
        {uri ? "Hands the PNG to the system share sheet." : "Capture the card first."}
      </Text>
      <Button
        label="Share PNG"
        variant="secondary"
        disabled={!uri || available !== true}
        onPress={() => {
          if (uri) void share(uri, "Share your ID card");
        }}
      />
      {error ? (
        <Notice
          tone="danger"
          title={available ? "Could not share" : "Could not check the share sheet"}
          body={error}
        />
      ) : null}
    </Section>
  );
}

function formatReading({ x, y, z }: { x: number; y: number; z: number }): string {
  return `x ${x.toFixed(2)}   y ${y.toFixed(2)}   z ${z.toFixed(2)}`;
}

function GyroscopeSection() {
  const { available, reduceMotion, listening, reading, error } =
    useGyroscopeReading(GYRO_INTERVAL_MS);
  const badge: Badge =
    available === null
      ? { label: "Checking", tone: "neutral" }
      : !available
        ? { label: error ? "Failed" : "No gyroscope", tone: "danger" }
        : listening
          ? { label: "Listening", tone: "success" }
          : { label: "Drag only", tone: "info" };

  return (
    <Section title="Gyroscope" badge={badge}>
      {reduceMotion ? (
        <Text className="text-callout text-gray-500">
          Reduce Motion is on: the card tilts by drag only, so nothing subscribes.
        </Text>
      ) : null}
      {error ? <Notice tone="danger" title="Could not check the gyroscope" body={error} /> : null}
      {available === false && !error ? (
        <Text className="text-callout text-gray-500">
          This device reports no gyroscope: the card tilts by drag only.
        </Text>
      ) : null}
      {listening ? (
        <Text className="text-body tabular-nums text-navy-900" testID="gyro-reading">
          {reading ? formatReading(reading) : "Waiting for the first reading"}
        </Text>
      ) : null}
      <Text className="text-footnote text-gray-500">
        {`Rotation rate in rad/s, every ${GYRO_INTERVAL_MS} ms.`}
      </Text>
    </Section>
  );
}

function HapticsSection() {
  const { taps, error, tap } = useHapticTaps();
  const badge: Badge =
    taps > 0 ? { label: `Sent x${taps}`, tone: "success" } : { label: "Not sent", tone: "neutral" };

  return (
    <Section title="Haptics" badge={badge}>
      <Text className="text-callout text-gray-500">
        A light impact, as a completed step will feel. The emulator cannot vibrate; the badge counts
        the calls.
      </Text>
      <Button label="Light tap" variant="secondary" onPress={() => void tap()} />
      {error ? <Notice tone="danger" title="Could not vibrate" body={error} /> : null}
    </Section>
  );
}

/** The five libraries of #250 on one page: camera, view-shot, sharing, gyroscope, haptics. */
export function IdCardLibsSample() {
  const { shot, capture, captureCard } = useCardCapture();
  const uri = capture.status === "captured" ? capture.uri : null;

  return (
    <View className="gap-4">
      <CameraSection />
      <SnapshotSection shot={shot} capture={capture} onCapture={() => void captureCard()} />
      <ShareSection uri={uri} />
      <GyroscopeSection />
      <HapticsSection />
    </View>
  );
}
