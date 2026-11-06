import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { GestureHandlerRootView, State } from "react-native-gesture-handler";
import {
  createGestureController,
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { useReducedMotion, withSpring, withTiming } from "react-native-reanimated";

import i18n from "@/i18n";

import { IdCard, type IdCardProps } from "../IdCard";

jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    useReducedMotion: jest.fn(() => false),
    withSpring: jest.fn(actual.withSpring),
    withTiming: jest.fn(actual.withTiming),
  };
});
// Root manual mocks (apps/mobile/__mocks__): named here so the test and the component share one instance.
jest.mock("expo-sensors");
jest.mock("expo-haptics");

const { Gyroscope } =
  jest.requireMock<typeof import("../../../../__mocks__/expo-sensors")>("expo-sensors");

const ALEX = {
  name: "Alex Morgan",
  city: "Fort Lauderdale",
  state: "FL",
  phone: "(954) 555-0142",
  publicCode: "K7Q29MXA",
};
const FRONT_LABEL = "ID card, PRO, Alex Morgan, Fort Lauderdale, FL";
const BACK_LABEL = "Back of the ID card, code K7Q2-9MXA";
const CUSTOMER_LABEL = "ID card, Alex Morgan, Fort Lauderdale, FL";
/** The card rises to a touch by this much (IdCard's LIFT_SCALE). */
const LIFT_SCALE = 1.03;

type PanPayload = { translationX: number; translationY: number; velocityX: number };

type Transform = Record<string, number | string>[];
type AnimatedStyle = { opacity?: number; transform?: Transform };

/** A face, shown or turned away (the one looking away is hidden from assistive technology). */
const face = (testID: string) => screen.getByTestId(testID, { includeHiddenElements: true });

/** The style Reanimated's Jest mock computed for a host view. */
const animatedStyle = (testID: string): AnimatedStyle =>
  (face(testID).props.jestAnimatedStyle as { value: AnimatedStyle }).value;

const rotation = (transform: Transform | undefined, axis: "rotateX" | "rotateY") =>
  Number.parseFloat(String(transform?.find((part) => axis in part)?.[axis] ?? "0deg"));

const flipByAssistiveTech = (testID: string) =>
  fireEvent(face(testID), "accessibilityAction", { nativeEvent: { actionName: "activate" } });

// GestureDetector refuses to render outside the root view the app's layout mounts.
const card = (props: IdCardProps) => (
  <GestureHandlerRootView>
    <IdCard {...props} />
  </GestureHandlerRootView>
);
const renderCard = (props: IdCardProps) => render(card(props));

/** Lets the gyroscope's availability answer land. */
const settle = () => act(async () => undefined);

beforeEach(() => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.mocked(withSpring).mockClear();
  jest.mocked(withTiming).mockClear();
  jest.mocked(Haptics.impactAsync).mockClear();
  Gyroscope.reset();
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("IdCard", () => {
  it("shows a pro's front: the greeting, the photo column with PRO, the name, the place, the phone", async () => {
    await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await settle();

    expect(screen.getByText("Hello, I'm:")).toBeOnTheScreen();
    expect(screen.getByText("Alex Morgan")).toBeOnTheScreen();
    expect(screen.getByText("Fort Lauderdale, FL")).toBeOnTheScreen();
    expect(screen.getByText("(954) 555-0142")).toBeOnTheScreen();
    expect(screen.getByText("PRO")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: FRONT_LABEL })).toBeOnTheScreen();
    // The back is drawn (turned away) but hidden from assistive technology until the flip.
    expect(screen.queryByText("K7Q2-9MXA")).toBeNull();
    expect(screen.getByText("K7Q2-9MXA", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: BACK_LABEL })).toBeNull();
  });

  it("shows a customer's front without PRO", async () => {
    await renderCard({
      variant: "customer",
      width: 320,
      name: "María Pérez",
      city: "Miami",
      state: "FL",
    });
    await settle();

    expect(screen.queryByText("PRO")).toBeNull();
    expect(
      screen.getByRole("button", { name: "ID card, María Pérez, Miami, FL" }),
    ).toBeOnTheScreen();
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderCard({ variant: "pro", width: 320, ...ALEX });
    await settle();

    expect(screen.getByText("Hola, soy:")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", {
        name: "Tarjeta de identificación, PRO, Alex Morgan, Fort Lauderdale, FL",
      }),
    ).toBeOnTheScreen();
  });

  it("says the name is not set yet on a blank card", async () => {
    await renderCard({ variant: "customer", width: 320 });
    await settle();

    expect(screen.getByRole("button", { name: "ID card, name not set yet" })).toBeOnTheScreen();
  });

  it("never draws the phone on a shareable render, which is a still image", async () => {
    await renderCard({ variant: "pro", width: 960, ...ALEX, shareable: true, testID: "share" });
    await settle();

    expect(screen.queryByText(ALEX.phone)).toBeNull();
    expect(screen.getByText("Alex Morgan")).toBeOnTheScreen();
    expect(screen.getByRole("image", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.queryByRole("button")).toBeNull();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
    expect(screen.getByTestId("share").props.style).toEqual(
      expect.arrayContaining([{ width: 960, height: 606 }]),
    );
  });

  it("flips through its accessibility action: the back becomes the one accessible element", async () => {
    const onFlip = jest.fn();
    await renderCard({ variant: "pro", width: 320, ...ALEX, onFlip: onFlip, testID: "card" });
    await settle();

    await act(async () => flipByAssistiveTech("card-front"));

    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
    expect(screen.getByText("K7Q2-9MXA")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: FRONT_LABEL })).toBeNull();
    expect(withSpring).toHaveBeenLastCalledWith(180, expect.any(Object));
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(onFlip).toHaveBeenLastCalledWith("back");

    await act(async () => flipByAssistiveTech("card-back"));

    expect(screen.getByRole("button", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(withSpring).toHaveBeenLastCalledWith(0, expect.any(Object));
    expect(onFlip).toHaveBeenLastCalledWith("front");
  });

  it("flips on a tap", async () => {
    await renderCard({ variant: "customer", width: 320, ...ALEX, testID: "card" });
    await settle();

    await act(async () => {
      fireGestureHandler(getByGestureTestId("card-tap"), [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { state: State.END },
      ]);
    });

    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
  });

  it("leans with a drag, settles on release, and turns over on a long or fast swipe", async () => {
    await renderCard({ variant: "customer", width: 320, ...ALEX, testID: "card" });
    await settle();
    // Step by step: the batch helper always ends the gesture, and the lean is read mid-drag.
    const pan = createGestureController<PanPayload>("card-pan");

    await act(async () => {
      pan.begin();
      pan.activate();
      pan.update({ translationX: 80, translationY: -40 });
    });
    const leaning = animatedStyle("card-front");
    // A drag to the right of a quarter width leans 12° around Y; up a fifth of the height leans
    // about 9.5° around X.
    expect(rotation(leaning.transform, "rotateY")).toBe(12);
    expect(rotation(leaning.transform, "rotateX")).toBeCloseTo(9.5, 1);
    expect(leaning.opacity).toBe(1);
    expect(withSpring).toHaveBeenCalledWith(LIFT_SCALE, expect.any(Object));

    await act(async () => {
      pan.end({ translationX: 80, translationY: -40, velocityX: 0 });
    });
    expect(withSpring).toHaveBeenCalledWith(0, expect.any(Object));
    expect(screen.getByRole("button", { name: CUSTOMER_LABEL })).toBeOnTheScreen();

    // A short, fast swipe to the left turns it over that way.
    await act(async () => {
      pan.begin();
      pan.activate();
      pan.update({ translationX: -40 });
      pan.end({ translationX: -60, velocityX: -900 });
    });
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
    expect(withSpring).toHaveBeenCalledWith(-180, expect.any(Object));

    // A slow drag past a third of the width turns it back.
    await act(async () => {
      pan.begin();
      pan.activate();
      pan.update({ translationX: 60 });
      pan.end({ translationX: 120, velocityX: 0 });
    });
    expect(screen.getByRole("button", { name: CUSTOMER_LABEL })).toBeOnTheScreen();

    // A short, slow drag does not.
    await act(async () => {
      pan.begin();
      pan.activate();
      pan.update({ translationX: 30 });
      pan.end({ translationX: 30, velocityX: 100 });
    });
    expect(screen.getByRole("button", { name: CUSTOMER_LABEL })).toBeOnTheScreen();
  });

  it("follows the gyroscope: one subscription, a nudge per reading, nothing after unmount", async () => {
    const view = await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await waitFor(() => expect(Gyroscope.addListener).toHaveBeenCalledTimes(1));
    expect(Gyroscope.updateIntervalMs).toBe(33);

    jest.mocked(withTiming).mockClear();
    await act(async () => Gyroscope.emit({ x: 1, y: 0.5, z: 0, timestamp: 1 }));
    const [[pitch], [roll]] = jest.mocked(withTiming).mock.calls;
    // The card counter-turns: a pitch nudges it the same way around X, a roll the other way around Y.
    expect(pitch).toBeCloseTo(2, 5);
    expect(roll).toBeCloseTo(-1, 5);

    // A steady turn settles well inside the cap.
    await act(async () => {
      for (let i = 0; i < 60; i += 1) Gyroscope.emit({ x: 4, y: 0, z: 0, timestamp: i });
    });
    const [last] = jest.mocked(withTiming).mock.calls.at(-2) ?? [];
    expect(last).toBeLessThanOrEqual(14);

    await view.unmount();
    expect(Gyroscope.hasListeners()).toBe(false);
  });

  it("holds still under Reduce Motion: no gyroscope, no lean, and the flip is a crossfade", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await settle();

    expect(Gyroscope.isAvailableAsync).not.toHaveBeenCalled();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();

    await act(async () => {
      fireGestureHandler(getByGestureTestId("card-pan"), [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { translationX: 80, translationY: -40 },
      ]);
    });
    const still = animatedStyle("card-front");
    expect(still.transform).toEqual([{ perspective: 700 }]);
    expect(still.opacity).toBe(1);
    expect(animatedStyle("card-back").opacity).toBe(0);

    await act(async () => flipByAssistiveTech("card-front"));
    expect(withTiming).toHaveBeenLastCalledWith(1, { duration: 200, reduceMotion: "never" });
    expect(withSpring).not.toHaveBeenCalledWith(180, expect.any(Object));
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
  });

  it("stays still when not interactive: an image, no gestures, no gyroscope", async () => {
    await renderCard({ variant: "pro", width: 320, ...ALEX, interactive: false, testID: "card" });
    await settle();

    expect(screen.getByRole("image", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.getByTestId("card-front").props.accessibilityActions).toBeUndefined();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
    expect(() => getByGestureTestId("card-pan")).not.toThrow();
    fireGestureHandler(getByGestureTestId("card-tap"), [{ state: State.END }]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("updates in place as a parent types: same instance, the shown face and the gyroscope kept", async () => {
    const view = await renderCard({
      variant: "customer",
      width: 320,
      name: "Mar",
      city: "Miami",
      state: "FL",
      publicCode: "9MXAK7Q2",
      testID: "card",
    });
    await waitFor(() => expect(Gyroscope.addListener).toHaveBeenCalledTimes(1));
    await act(async () => flipByAssistiveTech("card-front"));

    await view.rerender(
      card({
        variant: "customer",
        width: 320,
        name: "María",
        city: "Miami",
        state: "FL",
        publicCode: "9MXAK7Q2",
        testID: "card",
      }),
    );
    await view.rerender(
      card({
        variant: "customer",
        width: 320,
        name: "María Pérez",
        city: "Miami",
        state: "FL",
        phone: "(305) 555-0199",
        publicCode: "9MXAK7Q2",
        testID: "card",
      }),
    );

    expect(screen.getByText("María Pérez", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("(305) 555-0199", { includeHiddenElements: true })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back of the ID card, code 9MXA-K7Q2" }),
    ).toBeOnTheScreen();
    expect(Gyroscope.addListener).toHaveBeenCalledTimes(1);
    expect(Gyroscope.hasListeners()).toBe(true);
  });
});
