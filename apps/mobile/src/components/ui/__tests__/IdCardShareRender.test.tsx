import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { createRef } from "react";
import { Image, PixelRatio } from "react-native";

import "@/i18n";

import {
  idCardShareLayoutWidth,
  IdCardShareRender,
  type IdCardShareHandle,
} from "../IdCardShareRender";

// Root manual mock (apps/mobile/__mocks__), named so the test and the render share one instance.
jest.mock("react-native-view-shot");

const viewShot =
  jest.requireMock<typeof import("../../../../__mocks__/react-native-view-shot")>(
    "react-native-view-shot",
  );

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
const OTHER_PHOTO = "file:///cache/selfie-2.jpg";
const PHOTO_TIMEOUT_MS = 15_000;
const MARIA = {
  variant: "customer" as const,
  name: "María Pérez",
  city: "Miami",
  state: "FL",
  photoTimeoutMs: PHOTO_TIMEOUT_MS,
};
const LABEL = "ID card, María Pérez, Miami, FL";

const card = () => screen.getByRole("image", { name: LABEL, includeHiddenElements: true });
const photo = () => screen.getByTestId("share-card-photo", { includeHiddenElements: true });
/** Ends the current photo's load: RN's Image calls onLoadEnd on success and on failure alike. */
const endPhotoLoad = () => fireEvent(photo(), "loadEnd");

beforeEach(() => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(1);
  // getSize is overloaded (promise and callback forms), so the spy needs the promise form spelled out.
  jest
    .spyOn(Image, "getSize")
    .mockImplementation((() =>
      Promise.resolve({ width: 960, height: 606 })) as typeof Image.getSize);
  viewShot.captureRef.mockClear();
});

describe("idCardShareLayoutWidth", () => {
  it.each([
    [1, 960],
    [2, 480],
    [3, 320],
    [3.5, 320],
  ])(
    "at pixel ratio %d lays the card out %d dp wide, for a PNG of at least 960 px",
    (ratio, width) => {
      expect(idCardShareLayoutWidth(ratio)).toBe(width);
    },
  );
});

describe("IdCardShareRender", () => {
  it("lays the shareable card out at 3x, off the screen's left edge, hidden and inert", async () => {
    await render(<IdCardShareRender {...MARIA} publicCode="9MXAK7Q2" testID="share" />);

    const host = screen.getByTestId("share", { includeHiddenElements: true });
    expect(host.props.style).toEqual({ position: "absolute", top: 0, left: -1024, width: 960 });
    expect(host.props.pointerEvents).toBe("none");
    expect(host.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(host.props.accessibilityElementsHidden).toBe(true);
    expect(card().props.style).toEqual(expect.arrayContaining([{ width: 960, height: 606 }]));
    expect(screen.queryByRole("image", { name: LABEL })).toBeNull();
    expect(screen.getByText("María Pérez", { includeHiddenElements: true })).toBeTruthy();
  });

  it("captures a PNG at native size and reports its pixel size", async () => {
    const ref = createRef<IdCardShareHandle>();
    await render(<IdCardShareRender ref={ref} {...MARIA} testID="share" />);

    await expect(ref.current?.capture()).resolves.toEqual({
      uri: viewShot.MOCK_CAPTURE_URI,
      width: 960,
      height: 606,
    });
    expect(viewShot.captureRef).toHaveBeenCalledTimes(1);
    expect(viewShot.captureRef).toHaveBeenCalledWith(expect.anything(), {
      format: "png",
      quality: 1,
      result: "tmpfile",
    });
  });

  it("waits for the photo to load before capturing", async () => {
    const ref = createRef<IdCardShareHandle>();
    await render(<IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />);

    const done = jest.fn();
    const capture = ref.current?.capture().then(done);
    await act(async () => undefined);
    expect(viewShot.captureRef).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    await fireEvent(
      screen.getByTestId("share-card-photo", { includeHiddenElements: true }),
      "loadEnd",
    );
    await capture;
    expect(viewShot.captureRef).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({ uri: viewShot.MOCK_CAPTURE_URI, width: 960, height: 606 });

    // Loaded once, the same photo needs no second wait.
    await expect(ref.current?.capture()).resolves.toMatchObject({ width: 960 });
  });

  it("lets a waiting capture go on without the photo once it is taken away", async () => {
    const ref = createRef<IdCardShareHandle>();
    const view = await render(
      <IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />,
    );
    const capture = ref.current?.capture();

    await view.rerender(<IdCardShareRender ref={ref} {...MARIA} testID="share" />);

    await expect(capture).resolves.toMatchObject({ width: 960, height: 606 });
    expect(viewShot.captureRef).toHaveBeenCalledTimes(1);
  });

  it("fails a waiting capture when the render unmounts", async () => {
    const ref = createRef<IdCardShareHandle>();
    const view = await render(
      <IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />,
    );
    // The handler is attached before the unmount, as a real caller's await would be.
    const failed = expect(ref.current?.capture()).rejects.toThrow(
      "IdCardShareRender is not mounted",
    );

    await view.unmount();

    await failed;
    expect(viewShot.captureRef).not.toHaveBeenCalled();
  });

  // Gatekeeper round 1 (B1): readiness belongs to one load of the photo, never to its URI.
  it("waits for a photo put back after a removal, not for the load before it", async () => {
    const ref = createRef<IdCardShareHandle>();
    const view = await render(
      <IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />,
    );
    await endPhotoLoad();
    await view.rerender(<IdCardShareRender ref={ref} {...MARIA} testID="share" />);
    await view.rerender(<IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />);

    const capture = ref.current?.capture();
    await act(async () => undefined);
    expect(viewShot.captureRef).not.toHaveBeenCalled();

    await endPhotoLoad();
    await expect(capture).resolves.toMatchObject({ width: 960 });
    expect(viewShot.captureRef).toHaveBeenCalledTimes(1);
  });

  it("waits for a replacement photo: a late end from the one before does not count", async () => {
    const ref = createRef<IdCardShareHandle>();
    const view = await render(
      <IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />,
    );
    await endPhotoLoad();
    const staleEnd = photo().props.onLoadEnd as () => void;
    await view.rerender(
      <IdCardShareRender ref={ref} {...MARIA} photoUri={OTHER_PHOTO} testID="share" />,
    );
    expect(photo().props.source).toEqual({ uri: OTHER_PHOTO });

    const capture = ref.current?.capture();
    await act(async () => staleEnd());
    expect(viewShot.captureRef).not.toHaveBeenCalled();

    // The new photo fails to load: the capture goes on with the silhouette, never the old photo.
    await endPhotoLoad();
    await expect(capture).resolves.toMatchObject({ width: 960 });
    expect(viewShot.captureRef).toHaveBeenCalledTimes(1);
    expect(photo().props.source).toEqual({ uri: OTHER_PHOTO });
  });

  it("gives up on a photo that never ends its load, after the timeout it is given", async () => {
    const ref = createRef<IdCardShareHandle>();
    await render(<IdCardShareRender ref={ref} {...MARIA} photoUri={PHOTO} testID="share" />);
    jest.useFakeTimers();
    try {
      const failed = expect(ref.current?.capture()).rejects.toThrow("did not load in time");
      await act(async () => jest.advanceTimersByTime(PHOTO_TIMEOUT_MS - 1));
      expect(viewShot.captureRef).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(1));
      await failed;

      // A late end after the give-up captures nothing by itself, and the next capture goes on.
      await endPhotoLoad();
      expect(viewShot.captureRef).not.toHaveBeenCalled();
      await expect(ref.current?.capture()).resolves.toMatchObject({ width: 960 });
    } finally {
      jest.useRealTimers();
    }
  });
});
