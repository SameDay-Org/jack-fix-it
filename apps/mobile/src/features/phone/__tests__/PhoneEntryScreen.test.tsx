import "@/i18n";

import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo } from "react-native";

import {
  callBody,
  callHeader,
  callPath,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { phoneFlowStore } from "../phoneFlow";
import { PhoneEntryScreen } from "../PhoneEntryScreen";
import { DIGITS, E164, renderScreen, signIn, watchConsoleForPii } from "./helpers";

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
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const SEND = "/v1/auth/phone/send";

const field = () => screen.getByLabelText("Phone number");
const sendButton = () => screen.getByRole("button", { name: "Send code" });

let fetchMock: FetchMock;
let consoleWatch: ReturnType<typeof watchConsoleForPii>;
let announce: jest.SpyInstance;

beforeEach(() => {
  fetchMock = installFetchMock();
  consoleWatch = watchConsoleForPii();
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  phoneFlowStore.setState({ pendingNumber: null, offeredAfterSignUp: false });
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  jest.mocked(router.push).mockClear();
  jest.mocked(router.dismissTo).mockClear();
  signIn();
});

afterEach(() => {
  consoleWatch.assertNoPhoneOrCode();
  consoleWatch.restore();
  announce.mockRestore();
});

describe("PhoneEntryScreen", () => {
  it("formats the number as typed behind the fixed calling code, with the phone keyboard", async () => {
    await renderScreen(<PhoneEntryScreen />);

    expect(screen.getByTestId("phone-number-prefix")).toHaveTextContent("+1");
    expect(field().props).toMatchObject({
      keyboardType: "phone-pad",
      textContentType: "telephoneNumber",
      autoComplete: "tel",
    });

    await fireEvent.changeText(field(), "4155");
    expect(field().props.value).toBe("(415) 5");
    await fireEvent.changeText(field(), "+1 415 555 0123"); // autofill brings the calling code
    expect(field().props.value).toBe("(415) 555-0123");
  });

  it("submits E.164 with the session's token, then goes to the code step with the number", async () => {
    fetchMock.mockResolvedValue(jsonResponse(202));
    await renderScreen(<PhoneEntryScreen />);

    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/verify-phone/code"));
    const [call] = fetchMock.mock.calls;
    expect(callPath(call)).toBe(SEND);
    expect(callBody(call)).toEqual({ phone: E164 });
    expect(callHeader(call, "Authorization")).toBe("Bearer access-1");
    expect(phoneFlowStore.getState().pendingNumber).toBe(DIGITS);
  });

  it("a short number gets the validation message and sends nothing", async () => {
    await renderScreen(<PhoneEntryScreen />);

    await fireEvent.changeText(field(), "415555012");
    await fireEvent.press(sendButton());

    const message = "Enter a valid 10-digit US phone number.";
    expect(screen.getByText(message)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(message);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    await fireEvent.changeText(field(), DIGITS); // typing again clears it
    expect(screen.queryByText(message)).toBeNull();
  });

  it("rate_limited is shown under the field and announced", async () => {
    fetchMock.mockResolvedValue(errorResponse(429, "rate_limited"));
    await renderScreen(<PhoneEntryScreen />);

    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());

    const message = "Too many attempts. Try again in a moment.";
    expect(await screen.findByText(message)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(message);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("no connection shows the connection message", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await renderScreen(<PhoneEntryScreen />);

    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());

    expect(
      await screen.findByText("No connection. Check your internet and try again."),
    ).toBeTruthy();
  });

  it("while sending, the button shows progress, the field is disabled and a second tap sends nothing", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    await renderScreen(<PhoneEntryScreen />);

    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());
    await waitFor(() => expect(field().props.editable).toBe(false));
    // While busy the button's name gains ", Loading", so it is found by its id here.
    const busyButton = screen.getByTestId("phone-send");
    expect(busyButton.props.accessibilityState).toMatchObject({ busy: true });
    await fireEvent.press(busyButton);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer.resolve(jsonResponse(202));
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
  });

  it("from home: a Back button and no skip", async () => {
    await renderScreen(<PhoneEntryScreen />);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
  });

  it("right after a sign-up: Skip for now goes home, and the step is offered only once", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({ from: "sign-up" });
    phoneFlowStore.setState({ offeredAfterSignUp: true });
    await renderScreen(<PhoneEntryScreen />);

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(phoneFlowStore.getState().offeredAfterSignUp).toBe(false);

    await fireEvent.press(screen.getByRole("button", { name: "Skip for now" }));
    expect(router.dismissTo).toHaveBeenCalledWith("/");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a response that arrives after the user left (#178 round 1)", () => {
  it("a late 202 after Back never opens the code step or overwrites a later flow", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    const { unmount } = await renderScreen(<PhoneEntryScreen />);
    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    await unmount();
    phoneFlowStore.setState({ pendingNumber: "3055550123" }); // a newer flow's number
    await act(async () => answer.resolve(jsonResponse(202)));

    expect(router.push).not.toHaveBeenCalled();
    expect(phoneFlowStore.getState().pendingNumber).toBe("3055550123");
    expect(announce).not.toHaveBeenCalled();
  });

  it("a late failure after leaving is not announced", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    const { unmount } = await renderScreen(<PhoneEntryScreen />);
    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await unmount();
    await act(async () => answer.resolve(errorResponse(429, "rate_limited")));

    expect(announce).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("leaving cancels the request in flight", async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValue(answer.promise);
    const { unmount } = await renderScreen(<PhoneEntryScreen />);
    await fireEvent.changeText(field(), DIGITS);
    await fireEvent.press(sendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await unmount();

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => answer.resolve(jsonResponse(202)));
  });
});
