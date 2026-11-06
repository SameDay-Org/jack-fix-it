// Dev-only hooks behind the ID card libraries smoke screen (src/app/dev/id-card-libs.tsx, #251):
// one per library, each small enough to read as that library's usage note for #250.
import * as Haptics from "expo-haptics";
import { Gyroscope, type GyroscopeMeasurement } from "expo-sensors";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import type { CaptureOptions, ViewShotRef } from "react-native-view-shot";

/** The card as a lossless PNG in a temporary file: the share sheet takes a file, not pixels. */
export const CARD_CAPTURE_OPTIONS: CaptureOptions = {
  format: "png",
  quality: 1,
  result: "tmpfile",
};

export type CardCapture =
  | { status: "idle" }
  | { status: "capturing" }
  | { status: "captured"; uri: string; width: number; height: number }
  | { status: "failed"; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Captures the card inside the `ViewShot` that `shot` points at and reads the PNG's pixel size
 * back, so the screen can show what the share sheet would hand out.
 */
export function useCardCapture() {
  const shot = useRef<ViewShotRef>(null);
  const [capture, setCapture] = useState<CardCapture>({ status: "idle" });

  const captureCard = useCallback(async () => {
    const target = shot.current;
    if (!target) return;
    setCapture({ status: "capturing" });
    try {
      const uri = await target.capture();
      const { width, height } = await Image.getSize(uri);
      setCapture({ status: "captured", uri, width, height });
    } catch (error) {
      setCapture({ status: "failed", message: messageOf(error) });
    }
  }, []);

  return { shot, capture, captureCard };
}

/** The system share sheet for a PNG file; `available` is null until the device has answered. */
export function useShareSheet() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [shares, setShares] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Sharing.isAvailableAsync().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);

  const share = useCallback(async (uri: string, dialogTitle: string) => {
    setError(null);
    try {
      await Sharing.shareAsync(uri, { mimeType: "image/png", UTI: "public.png", dialogTitle });
      setShares((count) => count + 1);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  return { available, shares, error, share };
}

/**
 * A live gyroscope reading, or none: when the device has no gyroscope, or when the system asks for
 * reduced motion. Then the card falls back to drag only and nothing subscribes.
 */
export function useGyroscopeReading(intervalMs: number) {
  const reduceMotion = useReducedMotion();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reading, setReading] = useState<GyroscopeMeasurement | null>(null);

  useEffect(() => {
    let live = true;
    void Gyroscope.isAvailableAsync().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);

  const listening = available === true && !reduceMotion;

  useEffect(() => {
    if (!listening) return;
    Gyroscope.setUpdateInterval(intervalMs);
    const subscription = Gyroscope.addListener(setReading);
    return () => {
      subscription.remove();
      setReading(null);
    };
  }, [listening, intervalMs]);

  return { available, reduceMotion, listening, reading };
}

/** A light impact and how many were sent: the emulator cannot vibrate, so the count is the proof. */
export function useHapticTaps() {
  const [taps, setTaps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const tap = useCallback(async () => {
    setError(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setTaps((count) => count + 1);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  return { taps, error, tap };
}
