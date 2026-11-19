import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { GestureHandlerRootView, State } from "react-native-gesture-handler";
import {
  createGestureController,
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { useReducedMotion, withSpring, withTiming } from "react-native-reanimated";

import i18n from "@/i18n";
import { tokens } from "@/theme";

import { IdCard, type IdCardProps } from "../IdCard";
import { SHEEN_REST } from "../idCardModel";

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
const FRONT_LABEL = "ID card, PRO, Alex Morgan, Fort Lauderdale, FL, (954) 555-0142";
const BACK_LABEL = "Back of the ID card, code K7Q2-9MXA";
const CUSTOMER_LABEL = "ID card, Alex Morgan, Fort Lauderdale, FL, (954) 555-0142";
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

/**
 * Lets the gyroscope's availability answer land, then one UI frame pass. Under Jest, Reanimated
 * starts each animated style on the first frame after mount (the worklets UI queue runs on
 * `requestAnimationFrame`), so a drag driven before that frame moves shared values no style is
 * listening to yet, and the lean reads 0° (CI job 128243933434). On a phone that frame has long
 * passed before a finger lands. Frames run in order, so this one comes after the mount's.
 */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

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
    expect(StyleSheet.flatten(face("card-front").props.style).backgroundColor).toBe(
      tokens.colors["green-700"],
    );
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
      testID: "card",
    });
    await settle();

    expect(screen.queryByText("PRO")).toBeNull();
    expect(StyleSheet.flatten(face("card-front").props.style).backgroundColor).toBe(
      tokens.colors.white,
    );
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
        name: "Tarjeta de identificación, PRO, Alex Morgan, Fort Lauderdale, FL, (954) 555-0142",
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
    // Nor reads it out: the image is the card as drawn.
    expect(
      screen.getByRole("image", { name: "ID card, PRO, Alex Morgan, Fort Lauderdale, FL" }),
    ).toBeOnTheScreen();
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
    // An image-like object: its type ignores the font scale; the label carries the data.
    expect(screen.getByText("K7Q2-9MXA").props.allowFontScaling).toBe(false);
    expect(screen.queryByRole("button", { name: FRONT_LABEL })).toBeNull();
    expect(withSpring).toHaveBeenLastCalledWith(180, expect.any(Object));
    expect(onFlip).toHaveBeenLastCalledWith("back");
    // The tick comes as the card passes edge-on, once.
    await waitFor(() => expect(Haptics.impactAsync).toHaveBeenCalledTimes(1));

    await act(async () => flipByAssistiveTech("card-back"));

    expect(screen.getByRole("button", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(withSpring).toHaveBeenLastCalledWith(0, expect.any(Object));
    expect(onFlip).toHaveBeenLastCalledWith("front");
  });

  it("flips on a tap, and only on a tap: a scroll flick that starts on it is not one", async () => {
    await renderCard({ variant: "customer", width: 320, ...ALEX, testID: "card" });
    await settle();
    // The hook registers the native name of the limit.
    expect(getByGestureTestId("card-tap").config).toMatchObject({ maxDist: 8 });

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
    const sheen = animatedStyle("card-front-sheen");
    expect(sheen.transform?.[0]?.translateX).toBeGreaterThan(0);
    expect(sheen.opacity).toBeGreaterThan(0.07 * 0.6);

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
    expect(animatedStyle("card-front-sheen")).toEqual({ opacity: SHEEN_REST, transform: [] });

    await act(async () => flipByAssistiveTech("card-front"));
    expect(withTiming).toHaveBeenLastCalledWith(1, { duration: 200, reduceMotion: "never" });
    // A crossfade has no edge-on moment: the tick comes with the flip.
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(withSpring).not.toHaveBeenCalledWith(180, expect.any(Object));
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
  });

  it("stays still when not interactive: an image, no gestures, no gyroscope", async () => {
    const onFlip = jest.fn();
    await renderCard({
      variant: "pro",
      width: 320,
      ...ALEX,
      interactive: false,
      onFlip,
      testID: "card",
    });
    await settle();

    expect(screen.getByRole("image", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.getByTestId("card-front").props.accessibilityActions).toBeUndefined();
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
    expect(getByGestureTestId("card-tap").config.enabled).toBe(false);
    expect(getByGestureTestId("card-pan").config.enabled).toBe(false);

    // Even delivered, a tap and a swipe change nothing (the utility skips disabled gestures).
    await act(async () => {
      fireGestureHandler(getByGestureTestId("card-tap"), [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { state: State.END },
      ]);
      fireGestureHandler(getByGestureTestId("card-pan"), [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { translationX: 120 },
        { state: State.END, translationX: 160, velocityX: 900 },
      ]);
    });
    expect(onFlip).not.toHaveBeenCalled();
    expect(screen.getByRole("image", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.queryByRole("image", { name: BACK_LABEL })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["turns", false],
    ["fades", true],
  ])("%s back to its front when set at rest on its back (Reduce Motion %s)", async (_, reduced) => {
    jest.mocked(useReducedMotion).mockReturnValue(reduced);
    const onFlip = jest.fn();
    const props: IdCardProps = { variant: "pro", width: 320, ...ALEX, onFlip, testID: "card" };
    const view = await renderCard(props);
    await act(async () => flipByAssistiveTech("card-front"));
    expect(screen.getByRole("button", { name: BACK_LABEL })).toBeOnTheScreen();
    jest.mocked(withSpring).mockClear();
    jest.mocked(withTiming).mockClear();
    jest.mocked(Haptics.impactAsync).mockClear();

    await view.rerender(card({ ...props, interactive: false }));

    expect(screen.getByRole("image", { name: FRONT_LABEL })).toBeOnTheScreen();
    expect(screen.queryByRole("image", { name: BACK_LABEL })).toBeNull();
    if (reduced) {
      expect(withTiming).toHaveBeenCalledWith(0, { duration: 200, reduceMotion: "never" });
    } else {
      expect(withSpring).toHaveBeenCalledWith(0, expect.any(Object));
    }
    expect(onFlip).toHaveBeenLastCalledWith("front");
    // Set down, not flipped by the person: no tap feedback.
    expect(Haptics.impactAsync).not.toHaveBeenCalled();

    // Already on its front, a card set at rest stays as it is.
    onFlip.mockClear();
    await view.rerender(card({ ...props, interactive: true }));
    await view.rerender(card({ ...props, interactive: false }));
    expect(onFlip).not.toHaveBeenCalled();
  });

  it("never subscribes to a gyroscope that answers after the card is gone", async () => {
    let answer: (available: boolean) => void = () => undefined;
    Gyroscope.isAvailableAsync.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const view = await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await view.unmount();

    await act(async () => answer(true));
    expect(Gyroscope.addListener).not.toHaveBeenCalled();
    expect(Gyroscope.hasListeners()).toBe(false);
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
    const front = face("card-front");
    const back = face("card-back");

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
    // The very same host views: nothing under the card remounted (no flash).
    expect(face("card-front")).toBe(front);
    expect(face("card-back")).toBe(back);
  });

  // v2: the card is an image-like object at ID-1 size, so its type ignores the font scale (the
  // label carries the data) and the column flows: the place follows the name, with no empty line
  // under a one-line name. #291 B2's reserved room is gone with the scaling it guarded against.
  it("keeps its ID-1 size and fixed type: the name fits two lines, the place follows it", async () => {
    const props = { variant: "customer" as const, width: 288, city: "Miami", state: "FL" };
    const view = await renderCard({ ...props, name: "Mar", testID: "card" });

    await view.rerender(
      card({ ...props, name: "María Fernanda Pérez de la Cruz", testID: "card" }),
    );

    const name = screen.getByTestId("card-name");
    expect(name.props.numberOfLines).toBe(2);
    expect(name.props.adjustsFontSizeToFit).toBe(true);
    expect(name.props.allowFontScaling).toBe(false);
    expect(screen.getByText("Miami, FL").props.allowFontScaling).toBe(false);
    expect(screen.getByText("Miami, FL").props.numberOfLines).toBe(1);
    expect(screen.queryByTestId("card-name-room", { includeHiddenElements: true })).toBeNull();
    // Every face is exactly the card: 288 x 182, never taller with a long name.
    for (const id of ["card-front", "card-back"]) {
      expect(StyleSheet.flatten(face(id).props.style)).toMatchObject({ width: 288, height: 182 });
    }
    // The whole name stays in the label, however the drawn one shrinks.
    expect(
      screen.getByRole("button", { name: "ID card, María Fernanda Pérez de la Cruz, Miami, FL" }),
    ).toBeOnTheScreen();
  });

  it("seals the name only when verified, and reads the seal and the member-since line", async () => {
    const props: IdCardProps = { variant: "pro", width: 320, ...ALEX, testID: "card" };
    const view = await renderCard(props);
    expect(screen.queryByTestId("card-seal", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByText("MEMBER SINCE")).toBeNull();

    await view.rerender(card({ ...props, verified: true, memberSince: "March 2026" }));

    expect(screen.getByTestId("card-seal", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("MEMBER SINCE")).toBeOnTheScreen();
    expect(screen.getByText("March 2026")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", {
        name: "ID card, PRO, Alex Morgan, verified, Fort Lauderdale, FL, (954) 555-0142, member since March 2026",
      }),
    ).toBeOnTheScreen();

    await i18n.changeLanguage("es");
    await view.rerender(card({ ...props, verified: true, memberSince: "marzo de 2026" }));
    expect(screen.getByText("MIEMBRO DESDE")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", {
        name: "Tarjeta de identificación, PRO, Alex Morgan, verificado, Fort Lauderdale, FL, (954) 555-0142, miembro desde marzo de 2026",
      }),
    ).toBeOnTheScreen();
  });

  it("labels the back's engraved code, beside the support line", async () => {
    await renderCard({ variant: "customer", width: 320, ...ALEX, testID: "card" });
    await act(async () => flipByAssistiveTech("card-front"));

    expect(screen.getByText("MEMBER CODE")).toBeOnTheScreen();
    expect(screen.getByTestId("card-code")).toHaveTextContent("K7Q2-9MXA");
    expect(screen.getByText("Support when you need it")).toBeOnTheScreen();
  });

  it("turns away the face that looks away: both hide their backs, the back starts half a turn round", async () => {
    await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await settle();

    for (const id of ["card-front", "card-back"]) {
      expect(StyleSheet.flatten(face(id).props.style).backfaceVisibility).toBe("hidden");
    }
    expect(rotation(animatedStyle("card-front").transform, "rotateY")).toBe(0);
    expect(rotation(animatedStyle("card-back").transform, "rotateY")).toBe(180);
  });

  it("slides its layers against each other and its shadow against the lean", async () => {
    await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await settle();
    const pan = createGestureController<PanPayload>("card-pan");

    await act(async () => {
      pan.begin();
      pan.activate();
      pan.update({ translationX: 80, translationY: 0 });
    });

    const shiftX = (testID: string) => {
      const part = animatedStyle(testID).transform?.find((step) => "translateX" in step);
      return Number(part?.translateX ?? 0);
    };
    // The right edge leans back: what floats slides right, the deeper the further; the print,
    // under the laminate, slides left; the shadow moves the other way from the lean.
    const print = shiftX("card-front-print");
    const plate = shiftX("card-plate");
    const ink = shiftX("card-front-ink");
    const badge = shiftX("card-badge");
    expect(print).toBeLessThan(0);
    expect(plate).toBeGreaterThan(0);
    expect(ink).toBeGreaterThan(plate);
    expect(badge).toBeGreaterThan(ink);
    expect(shiftX("card-shadow")).toBeLessThan(0);
  });

  it("holds every layer and its shadow still under Reduce Motion", async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderCard({ variant: "pro", width: 320, ...ALEX, testID: "card" });
    await settle();

    await act(async () => {
      fireGestureHandler(getByGestureTestId("card-pan"), [
        { state: State.BEGAN },
        { state: State.ACTIVE },
        { translationX: 120, translationY: -60 },
      ]);
    });
    for (const id of ["card-front-print", "card-plate", "card-front-ink", "card-badge"]) {
      expect(animatedStyle(id).transform).toEqual([]);
    }
    expect(animatedStyle("card-shadow")).toMatchObject({ opacity: 1 });
    const shadowShift = animatedStyle("card-shadow").transform?.[0]?.translateX;
    expect(shadowShift).toBeCloseTo(0, 5);
  });

  it("draws the share image flat: no shadow, no edge, the light at rest, fixed type", async () => {
    await renderCard({
      variant: "pro",
      width: 960,
      ...ALEX,
      verified: true,
      memberSince: "March 2026",
      shareable: true,
      testID: "share",
    });
    await settle();

    expect(screen.queryByTestId("share-shadow", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("share-edge", { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId("share-seal", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByTestId("share-name").props.allowFontScaling).toBe(false);
    expect(
      StyleSheet.flatten(
        screen.getByTestId("share-front-sheen", { includeHiddenElements: true }).props.style,
      ),
    ).toMatchObject({
      opacity: SHEEN_REST,
    });
    expect(
      screen.getByRole("image", {
        name: "ID card, PRO, Alex Morgan, verified, Fort Lauderdale, FL, member since March 2026",
      }),
    ).toBeOnTheScreen();
  });
});
