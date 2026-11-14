// Manual Jest mock, applied to every suite (root __mocks__): each map component is a plain host
// view that carries the props the app gave it (a test reads them from the host), with a testID
// of `mapbox-<Component>` or `mapbox-<Component>-<id>`. The Camera's ref records `setCamera`, a
// ShapeSource's ref records `setNativeProps` by source id. Declare `jest.mock("@rnmapbox/maps")`
// in a test that reads these records, so the app and the test share one instance.
import { useImperativeHandle, type ComponentType, type ReactNode, type Ref } from "react";
import { View } from "react-native";

type MockProps = {
  children?: ReactNode;
  testID?: string;
  id?: string;
  ref?: Ref<unknown>;
} & Record<string, unknown>;

/** A host view that accepts any prop, like the native map components do. */
const Host = View as unknown as ComponentType<Record<string, unknown>>;

export const setAccessToken = jest.fn(async (_token: string | null) => undefined);
export const mockCamera = { setCamera: jest.fn() };
export const mockSourceProps = jest.fn((_id: string, _props: Record<string, unknown>) => undefined);

function component(name: string) {
  function MockMapboxComponent({ children, testID, ref: _ref, ...props }: MockProps) {
    const id = typeof props.id === "string" ? `-${props.id}` : "";
    return (
      <Host testID={testID ?? `mapbox-${name}${id}`} {...props}>
        {children}
      </Host>
    );
  }
  MockMapboxComponent.displayName = `Mock${name}`;
  return MockMapboxComponent;
}

export const MapView = component("MapView");
export const StyleImport = component("StyleImport");
export const CameraGestureObserver = component("CameraGestureObserver");
export const Images = component("Images");
export const Image = component("Image");
export const LineLayer = component("LineLayer");
export const SymbolLayer = component("SymbolLayer");
export const ModelLayer = component("ModelLayer");
export const Models = component("Models");

const CameraHost = component("Camera");
export function Camera({ ref, ...props }: MockProps) {
  useImperativeHandle(ref, () => ({ setCamera: mockCamera.setCamera }), []);
  return <CameraHost {...props} />;
}

const SourceHost = component("ShapeSource");
export function ShapeSource({ ref, ...props }: MockProps) {
  const id = String(props.id);
  useImperativeHandle(
    ref,
    () => ({ setNativeProps: (next: Record<string, unknown>) => mockSourceProps(id, next) }),
    [id],
  );
  return <SourceHost {...props} />;
}
