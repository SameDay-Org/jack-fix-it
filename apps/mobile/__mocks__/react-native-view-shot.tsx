// Manual Jest mock, applied to every suite (root __mocks__): `ViewShot` is a plain host view whose
// ref carries `capture`, and every capture resolves to `MOCK_CAPTURE_URI` without a native pass.
import { useImperativeHandle, useRef, type ComponentRef, type Ref } from "react";
import { View } from "react-native";
import type { CaptureOptions, ViewShotProperties, ViewShotRef } from "react-native-view-shot";

export const MOCK_CAPTURE_URI = "file:///mock/view-shot.png";

export const captureRef = jest.fn(
  async (_view: unknown, _options?: CaptureOptions): Promise<string> => MOCK_CAPTURE_URI,
);
export const captureScreen = jest.fn(
  async (_options?: CaptureOptions): Promise<string> => MOCK_CAPTURE_URI,
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
