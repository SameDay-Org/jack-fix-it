import "@/i18n";

import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, NetworkError, register } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { SignUpScreen } from "../SignUpScreen";
import { renderInSafeArea } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({ ...jest.requireActual("@/api"), register: jest.fn() }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({ role: "pro" })),
  Redirect: jest.fn(() => null),
  // The focus effect (hardware back while focused) runs only where a test calls it.
  useFocusEffect: jest.fn(),
  useIsFocused: jest.fn(() => true),
  // The stack's events: `transitionEnd` tells the content its screen has appeared.
  useNavigation: jest.fn(() => ({ addListener: jest.fn(() => jest.fn()) })),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const email = () => screen.getByLabelText("Email");
const password = () => screen.getByLabelText("Password");
const bubble = (field: "email" | "password") =>
  screen.getByTestId(`sign-up-screen-${field}-bubble`);
const submitButton = () => screen.getByRole("button", { name: "Create account" });

async function fillAndSubmit(address: string, secret: string) {
  await fireEvent.changeText(email(), address);
  await fireEvent.changeText(password(), secret);
  await fireEvent.press(submitButton());
}

let announce: jest.SpyInstance;

beforeEach(() => {
  jest.mocked(register).mockReset();
  jest.mocked(router.replace).mockClear();
  jest.mocked(Redirect).mockClear();
  jest.mocked(useLocalSearchParams).mockReturnValue({ role: "pro" });
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
});

afterEach(() => announce.mockRestore());

describe("SignUpScreen", () => {
  it("submits register with the chosen role and the device locale, email normalized", async () => {
    jest.mocked(register).mockResolvedValue(undefined);
    await renderInSafeArea(<SignUpScreen />);
    expect(screen.getByText("As a pro")).toBeTruthy();
    expect(screen.getByText("At least 10 characters")).toBeTruthy();

    await fillAndSubmit("  Maria@Example.com ", "correct horse battery");

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        email: "maria@example.com",
        password: "correct horse battery",
        role: "pro",
        locale: "en",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the phone step before the request (the gate reads it as the session flips), and withdraws it on failure", async () => {
    phoneFlowStore.setState({ offeredAfterSignUp: false });
    let offeredDuringRequest: boolean | undefined;
    jest.mocked(register).mockImplementationOnce(async () => {
      offeredDuringRequest = phoneFlowStore.getState().offeredAfterSignUp;
    });
    await renderInSafeArea(<SignUpScreen />);
    await fillAndSubmit("maria@example.com", "correct horse battery");
    await waitFor(() => expect(offeredDuringRequest).toBe(true));
    expect(phoneFlowStore.getState().offeredAfterSignUp).toBe(true);

    jest.mocked(register).mockRejectedValueOnce(new NetworkError(false));
    await fireEvent.press(submitButton());
    await waitFor(() => expect(phoneFlowStore.getState().offeredAfterSignUp).toBe(false));
  });

  it("client-side email and password-length validation runs before any request", async () => {
    await renderInSafeArea(<SignUpScreen />);

    await fillAndSubmit("not-an-email", "short");

    expect(screen.getByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText("Use at least 10 characters.")).toBeTruthy();
    expect(bubble("email").props.className).toContain("border-danger");
    expect(bubble("password").props.className).toContain("border-danger");
    expect(register).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("Enter a valid email address.");

    // Editing a field clears its message.
    await fireEvent.changeText(email(), "maria@example.com");
    expect(screen.queryByText("Enter a valid email address.")).toBeNull();
    expect(screen.getByText("Use at least 10 characters.")).toBeTruthy();
  });

  it.each([
    [422, "validation_error", "Check the highlighted fields."],
    [429, "rate_limited", "Too many attempts. Try again in a moment."],
    [500, "internal_error", "Something went wrong. Try again."],
    [400, undefined, "Something went wrong. Try again."],
  ])(
    "maps %s %s to its message, announced, with no raw server text",
    async (status, code, message) => {
      jest.mocked(register).mockRejectedValue(new ApiError(status, code));
      await renderInSafeArea(<SignUpScreen />);

      await fillAndSubmit("maria@example.com", "correct horse battery");

      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(announce).toHaveBeenCalledWith(message);
      expect(screen.queryByText(/API request failed/)).toBeNull();
    },
  );

  it("an email already registered marks the field and offers to log in instead", async () => {
    jest.mocked(register).mockRejectedValue(new ApiError(409, "email_already_registered"));
    await renderInSafeArea(<SignUpScreen />);

    await fillAndSubmit("maria@example.com", "correct horse battery");

    expect(await screen.findAllByText("An account with this email already exists.")).toHaveLength(
      1,
    );
    expect(bubble("email").props.className).toContain("border-danger");
    expect(bubble("password").props.className).not.toContain("border-danger");
    await fireEvent.press(screen.getByRole("button", { name: "Log in instead" }));
    expect(router.replace).toHaveBeenCalledWith("/(auth)/login");
  });

  it("NetworkError shows the connection message", async () => {
    jest.mocked(register).mockRejectedValue(new NetworkError(false));
    await renderInSafeArea(<SignUpScreen />);

    await fillAndSubmit("maria@example.com", "correct horse battery");

    expect(
      await screen.findByText("No connection. Check your internet and try again."),
    ).toBeTruthy();
  });

  it("button loading and fields disabled while submitting", async () => {
    const pending = deferred<void>();
    jest.mocked(register).mockReturnValue(pending.promise);
    await renderInSafeArea(<SignUpScreen />);

    await fillAndSubmit("maria@example.com", "correct horse battery");

    const busy = await screen.findByRole("button", { name: "Create account, Loading" });
    expect(busy.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(email().props.editable).toBe(false);
    expect(password().props.editable).toBe(false);

    pending.resolve();
    await waitFor(() =>
      expect(submitButton().props.accessibilityState).toMatchObject({ busy: false }),
    );
    expect(email().props.editable).toBe(true);
  });

  it("without a valid role it goes back to the role choice", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({ role: "admin" });
    await renderInSafeArea(<SignUpScreen />);

    expect(Redirect).toHaveBeenCalledWith(
      expect.objectContaining({ href: "/(auth)/role" }),
      undefined,
    );
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});
