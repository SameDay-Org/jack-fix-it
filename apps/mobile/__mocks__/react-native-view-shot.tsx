// Manual Jest mock, applied to every suite (root __mocks__): `ViewShot` is a plain host view whose
// ref carries `capture`, and every capture resolves without a native pass, in the result format it
// asks for: `MOCK_CAPTURE_BASE64` for "base64", a data URI of it for "data-uri", otherwise
// `MOCK_CAPTURE_URI` (a "tmpfile").
import { useImperativeHandle, useRef, type ComponentRef, type Ref } from "react";
import { View } from "react-native";
import type { CaptureOptions, ViewShotProperties, ViewShotRef } from "react-native-view-shot";

export const MOCK_CAPTURE_URI = "file:///mock/view-shot.png";
/** The 8-byte PNG signature, base64: enough for a file to hold "a PNG" in a test. */
export const MOCK_CAPTURE_BASE64 = "iVBORw0KGgo=";

function captured(options?: CaptureOptions): string {
  if (options?.result === "base64") return MOCK_CAPTURE_BASE64;
  if (options?.result === "data-uri") return `data:image/png;base64,${MOCK_CAPTURE_BASE64}`;
  return MOCK_CAPTURE_URI;
}

export const captureRef = jest.fn(
  async (_view: unknown, options?: CaptureOptions): Promise<string> => captured(options),
);
export const captureScreen = jest.fn(async (options?: CaptureOptions): Promise<string> =>
  captured(options),
);
export const releaseCapture = jest.fn((_uri: string): void => undefined);

type ViewShotMockProps = ViewShotProperties & { ref?: Ref<ViewShotRef> };

function ViewShot({ ref, children, options, style, onLayout }: ViewShotMockProps) {
  const root = useRef<ComponentRef<typeof View>>(null);

  useImperativeHandle(ref, () => {
    const node = root.current;
    if (!node) throw new Error("ViewShot mock: the host view is not mounted");
    return Object.assign(node, { capture: () => captureRef(root, options) });
  }, [options]);

  return (
    <View ref={root} collapsable={false} style={style} onLayout={onLayout}>
      {children}
    </View>
  );
}

export default Object.assign(ViewShot, { captureRef, releaseCapture });
