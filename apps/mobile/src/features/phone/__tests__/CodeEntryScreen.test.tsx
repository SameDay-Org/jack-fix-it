import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Redirect, router } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { showToast } from "@/components/ui";

import {
  callBody,
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { sessionStore } from "../../../api/session";
import { CodeEntryScreen } from "../CodeEntryScreen";
import { phoneConfig } from "../config";
import { phoneFlowStore } from "../phoneFlow";
import { CODE, DIGITS, E164, renderScreen, signIn, watchConsoleForPii } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
  Redirect: jest.fn(() => null),
}));
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  showToast: jest.fn(),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const SEND = "/v1/auth/phone/send";
const VERIFY = "/v1/auth/phone/verify";
const VERIFIED = { ...user, phone: E164, phone_verified: true };

const codeField = () => screen.getByLabelText("Verification code");
const resendButton = () => screen.getByTestId("phone-resend");
const typeCode = (code: string) => fireEvent.changeText(codeField(), code);

let fetchMock: FetchMock;
let consoleWatch: ReturnType<typeof watchConsoleForPii>;
let announce: jest.SpyInstance;

beforeEach(() => {
  fetchMock = installFetchMock();
  consoleWatch = watchConsoleForPii();
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  phoneFlowStore.setState({ pendingNumber: DIGITS, offeredAfterSignUp: false });
  jest.mocked(router.back).mockClear();
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(Redirect).mockClear();
  jest.mocked(showToast).mockClear();
  signIn();
});

afterEach(() => {
  consoleWatch.assertNoPhoneOrCode();
  consoleWatch.restore();
  announce.mockRestore();
  jest.useRealTimers();
});

describe("CodeEntryScreen", () => {
  it("shows where the code went and offers the system's one-time code autofill", async () => {
    await renderScreen(<CodeEntryScreen />);

    expect(screen.getByTestId("code-sent-to")).toHaveTextContent(
      "We sent it to +1 (415) 555-0123.",
    );
    expect(codeField().props).toMatchObject({
      textContentType: "oneTimeCode",
      autoComplete: "sms-otp",
      keyboardType: "number-pad",
    });
  });

  it("the sixth digit submits the code on its own, once", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, VERIFIED));
    await renderScreen(<CodeEntryScreen />);

    await typeCode(CODE.slice(0, 5));
    expect(fetchMock).not.toHaveBeenCalled();
    await typeCode(CODE);

    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [call] = fetchMock.mock.calls;
    expect(callPath(call)).toBe(VERIFY);
    expect(callBody(call)).toEqual({ phone: E164, code: CODE });
  });

  it("success: the session user becomes verified, with a toast, and home is next", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, VERIFIED));
    await renderScreen(<CodeEntryScreen />);

    await typeCode(CODE);

    await waitFor(() => expect(sessionStore.getState().user).toEqual(VERIFIED));
    expect(showToast).toHaveBeenCalledWith({ message: "Phone verified", tone: "success" });
    expect(router.dismissTo).toHaveBeenCalledWith("/");
  });

  it("while verifying, the button shows progress and the code holds (the field keeps its keyboard)", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    await renderScreen(<CodeEntryScreen />);

    await typeCode(CODE);
    await waitFor(() =>
      expect(screen.getByTestId("phone-verify").props.accessibilityState).toMatchObject({
        busy: true,
      }),
    );
    // Still editable, so Android keeps focus and the keyboard for a retry; edits wait meanwhile.
    expect(codeField().props.editable).toBe(true);
    await typeCode("9");
    expect(codeField().props.value).toBe(CODE);

    answer.resolve(jsonResponse(200, VERIFIED));
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalled());
  });

  it.each([
    [400, "invalid_code", "That code isn't right. Check it and try again."],
    [409, "phone_unavailable", "This number can't be used. Try another one."],
    [
      503,
      "verification_unavailable",
      "We couldn't send or check the code right now. Try again soon.",
    ],
    [429, "rate_limited", "Too many attempts. Try again in a moment."],
  ])("%i %s is shown under the code and announced", async (status, code, message) => {
    fetchMock.mockResolvedValue(errorResponse(status, code));
    await renderScreen(<CodeEntryScreen />);

    await typeCode(CODE);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(message);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(sessionStore.getState().user?.phone_verified).toBe(false);
    // A wrong code is cleared for the next try; other failures keep it to retry as is.
    expect(codeField().props.value).toBe(code === "invalid_code" ? "" : CODE);
  });

  it("resend waits for the countdown, shows the seconds left, then sends again and restarts it", async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse(202));
    await renderScreen(<CodeEntryScreen />);
    const { resendSeconds } = phoneConfig;

    expect(resendButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(resendButton()).toHaveTextContent(`Resend code in ${resendSeconds} s`);
    await fireEvent.press(resendButton());
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime((resendSeconds - 1) * 1000));
    expect(resendButton()).toHaveTextContent("Resend code in 1 s");
    expect(resendButton().props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => jest.advanceTimersByTime(1000));
    expect(resendButton()).toHaveTextContent("Resend code");
    expect(resendButton().props.accessibilityState).toMatchObject({ disabled: false });

    await fireEvent.press(resendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(callPath(fetchMock.mock.calls[0])).toBe(SEND);
    expect(callBody(fetchMock.mock.calls[0])).toEqual({ phone: E164 });
    await waitFor(() =>
      expect(resendButton()).toHaveTextContent(`Resend code in ${resendSeconds} s`),
    );
    expect(showToast).toHaveBeenCalledWith({ message: "We sent a new code.", tone: "neutral" });
  });

  it("Change number goes back to the phone step", async () => {
    await renderScreen(<CodeEntryScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Change number" }));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("with no number waiting for a code (a deep link) it goes to the phone step", async () => {
    phoneFlowStore.setState({ pendingNumber: null });
    await renderScreen(<CodeEntryScreen />);
    expect(jest.mocked(Redirect).mock.calls[0][0]).toEqual({ href: "/verify-phone" });
  });

  it("forgets the number once the step is gone", async () => {
    const { unmount } = await renderScreen(<CodeEntryScreen />);
    await unmount();
    expect(phoneFlowStore.getState().pendingNumber).toBeNull();
  });
});
