// Manual Jest mock, applied to every suite (root __mocks__): the permission hook answers from the
// two jest.fn below (undetermined, then granted on request, unless a test says otherwise) and the
// preview is a plain host view that carries the camera props and reports ready once active.
import type { CameraViewProps } from "expo-camera";
import { PermissionStatus, type PermissionResponse } from "expo-modules-core";
import { useCallback, useEffect, useEffectEvent, useState, type ComponentType } from "react";
import { View, type ViewProps } from "react-native";

export { PermissionStatus };

const response = (status: PermissionStatus, canAskAgain = true): PermissionResponse => ({
  status,
  granted: status === PermissionStatus.GRANTED,
  canAskAgain,
  expires: "never",
});

/** The answers a test hands to `getCameraPermissionsAsync` / `requestCameraPermissionsAsync`. */
export const CAMERA_PERMISSION = {
  undetermined: response(PermissionStatus.UNDETERMINED),
  granted: response(PermissionStatus.GRANTED),
  /** Refused once; the system may ask again. */
  denied: response(PermissionStatus.DENIED),
  /** Refused for good: only the device settings can turn it on. */
  blocked: response(PermissionStatus.DENIED, false),
} as const;

export const getCameraPermissionsAsync = jest.fn(
  async (): Promise<PermissionResponse> => CAMERA_PERMISSION.undetermined,
);
export const requestCameraPermissionsAsync = jest.fn(
  async (): Promise<PermissionResponse> => CAMERA_PERMISSION.granted,
);

export const Camera = { getCameraPermissionsAsync, requestCameraPermissionsAsync };

/** With a message here, every active preview fails to mount with it instead of reporting ready. */
export const cameraMock = { mountError: null as string | null };

type PermissionHook = [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
];

export function useCameraPermissions(): PermissionHook {
  const [current, setCurrent] = useState<PermissionResponse | null>(null);

  const get = useCallback(async () => {
    const next = await getCameraPermissionsAsync();
    setCurrent(next);
    return next;
  }, []);
  const request = useCallback(async () => {
    const next = await requestCameraPermissionsAsync();
    setCurrent(next);
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    void getCameraPermissionsAsync().then((next) => {
      if (live) setCurrent(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return [current, request, get];
}

type HostCameraProps = ViewProps & Pick<CameraViewProps, "active" | "facing" | "mode" | "mute">;

// The host view keeps the camera props as they are, so a test reads `props.facing` off the element.
const HostCamera = View as ComponentType<HostCameraProps>;

export function CameraView({
  active = true,
  facing = "back",
  mode,
  mute,
  onCameraReady,
  onMountError,
  style,
  testID,
  accessibilityLabel,
}: CameraViewProps) {
  // Reports once per mount and again when the lens or `active` changes, as the native view does;
  // a parent re-render alone (new callback identities) reports nothing.
  const report = useEffectEvent(() => {
    if (cameraMock.mountError) onMountError?.({ message: cameraMock.mountError });
    else onCameraReady?.();
  });
  useEffect(() => {
    if (active) report();
  }, [active, facing]);

  return (
    <HostCamera
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={style}
      active={active}
      facing={facing}
      mode={mode}
      mute={mute}
    />
  );
}
