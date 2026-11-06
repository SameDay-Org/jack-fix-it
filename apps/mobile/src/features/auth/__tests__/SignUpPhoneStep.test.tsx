import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiPost, endOnboarding, sessionGeneration, type SessionUser } from "@/api";
import { moveAccessibilityFocus } from "@/components/ui";

import {
  authResponse,
  callsTo,
  deferred,
  installFetchMock,
  jsonResponse,
  user,
} from "../../../api/__tests__/helpers";
import { apiPost as sentPost } from "../../../api/client";
import { login, sessionStore } from "../../../api/session";
import { phoneConfig } from "../../phone/config";
import { phoneFlowStore } from "../../phone/phoneFlow";
import { SignUpScreen } from "../SignUpScreen";
import { renderInSafeArea, SIGNED_OUT } from "./helpers";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);
jest.mock("@/api", () => ({
  ...jest.requireActual("@/api"),
  apiPost: jest.fn(),
  apiPatch: jest.fn(),
  apiGet: jest.fn(),
  // The flow ends only once nothing blocks leaving: the gate's switch to the app must not be
  // refused by the screen's own guard.
  endOnboarding: jest.fn(async () => {
    if (mockGuard.on) throw new Error("ended while the screen still blocks leaving");
  }),
}));
// The last guard the screen set: whether it blocks leaving, and what a blocked Back does.
const mockGuard = { on: false, onBlocked: (): void => undefined };
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  Redirect: jest.fn(() => null),
  usePreventRemove: jest.fn((on: boolean, onBlocked: () => void) => {
    mockGuard.on = on;
    mockGuard.onBlocked = onBlocked;
  }),
}));
// Every timing ends at once and reports it: a pane's slide and the finish settle inside the test.
jest.mock("react-native-reanimated", () => {
  const actual =
    jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated");
  return {
    __esModule: true,
    ...actual,
    withTiming: (to: number, _config?: object, done?: (finished?: boolean) => void) => {
      done?.(true);
      return to;
    },
  };
});
// Focus moves to a host node; recorded here to know which one.
jest.mock("@/components/ui", () => ({
  ...jest.requireActual("@/components/ui"),
  moveAccessibilityFocus: jest.fn(),
}));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// The card has its own tests (#291): here it shows what the flow hands it.
jest.mock("../../../components/ui/IdCard", () => ({
  IdCard: ({ name, phone, photoUri }: Record<string, string | undefined>) => {
    const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
    return (
      <>
        <Text testID="card">{`${name ?? ""}|${phone ?? ""}`}</Text>
        <Text testID="card-photo">{photoUri ?? ""}</Text>
      </>
    );
  },
}));

const SEND = "/v1/auth/phone/send";
const VERIFY = "/v1/auth/phone/verify";
const DIGITS = "4155550123";
const E164 = "+14155550123";
const SHOWN = "+1 (415) 555-0123";
const CODE = "123456";

const photographed: SessionUser = {
  ...user,
  role: "pro",
  first_name: "Ana",
  last_name: "Cruz",
  home_city: "Miami",
  home_state: "FL",
  photo: { url: "https://storage.example/photo.jpg", expires_at: "2026-11-06T12:00:00Z" },
};
const cardPhoto = () => screen.getByTestId("card-photo").props.children as string;
const PHOTO = "https://storage.example/photo.jpg";
// Every user the API returns signs the photo's URL afresh.
const VERIFIED: SessionUser = {
  ...photographed,
  phone: E164,
  phone_verified: true,
  photo: { url: `${PHOTO}?signed=2`, expires_at: "2026-11-06T13:00:00Z" },
};

const card = () => screen.getByTestId("card").props.children as string;
const button = (name: string) => screen.getByRole("button", { name });
const numberField = () => screen.getByLabelText("Phone number");
const codeField = () => screen.getByLabelText("Verification code");

/** The account on this device's flow, as a relaunch finds it. */
function onFlow(account: SessionUser = photographed) {
  sessionStore.setState({
    status: "signedIn",
    user: account,
    accessToken: "access",
    accessTokenExpiresAt: Date.now() + 60 * 60_000,
    onboardingUserId: account.id,
  });
}

/** The pane titled `title` is on screen and its slide is over: its action and fields take input. */
async function arrive(title: string) {
  const heading = await screen.findByText(title);
  await waitFor(() =>
    expect(
      screen.getByTestId("sign-up-step-leaving", { includeHiddenElements: true }).props.children,
    ).toBeNull(),
  );
  return heading;
}

async function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await renderInSafeArea(
    <QueryClientProvider client={client}>
      <SignUpScreen />
    </QueryClientProvider>,
  );
}

type Answer = () => Promise<SessionUser | undefined>;

/** Each phone call answers with what `answers` holds for its path, in order. */
function answer(answers: Partial<Record<string, Answer[]>>) {
  jest.mocked(apiPost).mockImplementation(async (path) => {
    const next = answers[path]?.shift();
    if (!next) throw new Error(`unexpected call to ${path}`);
    return next();
  });
}
const accepted: Answer = () => Promise.resolve(undefined);
const verified: Answer = () => Promise.resolve(VERIFIED);
const refused =
  (status: number, code: string): Answer =>
  () =>
    Promise.reject(new ApiError(status, code));

const calls = (path: string) => jest.mocked(apiPost).mock.calls.filter(([p]) => p === path);

/** On the phone step with the number typed and its code sent: the code pane is in place. */
async function sendCode() {
  await renderFlow();
  await fireEvent.changeText(numberField(), DIGITS);
  await act(async () => fireEvent.press(button("Send code")));
  await arrive("Enter the code we sent");
}

let announce: jest.SpyInstance;

beforeEach(() => {
  mockGuard.on = false;
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null });
  jest.mocked(apiPost).mockReset();
  jest.mocked(endOnboarding).mockClear();
  jest.mocked(router.push).mockClear();
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("SignUpScreen: the phone step", () => {
  it("resumes here once the photo is saved; the number goes on the card as it is typed", async () => {
    onFlow();
    await renderFlow();

    expect(screen.getByText("What's your number?")).toBeTruthy();
    expect(screen.getByLabelText("Step 5 of 5")).toBeTruthy();
    expect(card()).toBe("Ana Cruz|");

    await fireEvent.changeText(numberField(), "415555");
    expect(card()).toBe("Ana Cruz|+1 (415) 555");
    await fireEvent.changeText(numberField(), DIGITS);
    expect(card()).toBe(`Ana Cruz|${SHOWN}`);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("a number that is not a valid US one is caught before any request", async () => {
    onFlow();
    await renderFlow();
    await fireEvent.changeText(numberField(), "1235550123");

    await act(async () => fireEvent.press(button("Send code")));

    expect(screen.getByText("Enter a valid 10-digit US phone number.")).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.queryByText("Enter the code we sent")).toBeNull();
  });

  it("sends the code, asks for it in place, and a right code ends on the finished card", async () => {
    onFlow();
    answer({ [SEND]: [accepted], [VERIFY]: [verified] });
    await sendCode();

    expect(calls(SEND)).toEqual([[SEND, { phone: E164 }, expect.objectContaining({ auth: true })]]);
    expect(screen.getByText(`We sent it to ${SHOWN}.`)).toBeTruthy();
    expect(screen.getByLabelText("Step 5 of 5")).toBeTruthy(); // the code is the same step
    expect(card()).toBe(`Ana Cruz|${SHOWN}`);
    expect(button("Verify")).toBeDisabled();

    // The sixth digit sends the code on its own.
    jest.mocked(moveAccessibilityFocus).mockClear();
    await act(async () => fireEvent.changeText(codeField(), CODE));

    expect(calls(VERIFY)).toEqual([
      [VERIFY, { phone: E164, code: CODE }, expect.objectContaining({ auth: true })],
    ]);
    expect(await screen.findByText("Account created! Here's your ID:")).toBeTruthy();
    expect(screen.getByText("Tap it to see the back.")).toBeTruthy();
    // A screen reader starts on the headline once it is there.
    await waitFor(() => expect(moveAccessibilityFocus).toHaveBeenCalledTimes(1));
    expect(jest.mocked(moveAccessibilityFocus).mock.calls[0][0]).toBeTruthy();
    expect(sessionStore.getState().user?.phone_verified).toBe(true);
    expect(card()).toBe(`Ana Cruz|${SHOWN}`);
    // The answer's fresh signed URL is the same photo: the card keeps the one it shows.
    expect(cardPhoto()).toBe(PHOTO);
    // The steps are gone; the flow still holds the person until they go on.
    expect(screen.queryByText("Enter the code we sent")).toBeNull();
    expect(screen.queryByLabelText("Step 5 of 5")).toBeNull();
    expect(endOnboarding).not.toHaveBeenCalled();
    expect(mockGuard.on).toBe(true);
    await act(async () => mockGuard.onBlocked()); // a system Back stays on the card
    expect(screen.getByText("Account created! Here's your ID:")).toBeTruthy();
    // Nothing else is shown over it: no toast, no phone step to open later.
    expect(router.push).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(button("Let's go")));

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(mockGuard.on).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a wrong or expired code is cleared and said; the next one is checked", async () => {
    onFlow();
    answer({
      [SEND]: [accepted],
      [VERIFY]: [refused(400, "invalid_code"), verified],
    });
    await sendCode();

    await act(async () => fireEvent.changeText(codeField(), "000000"));

    const message = "That code isn't right. Check it and try again.";
    expect(await screen.findByText(message)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(message);
    expect(codeField().props.value).toBe("");
    expect(sessionStore.getState().user?.phone_verified).toBe(false);

    await act(async () => fireEvent.changeText(codeField(), CODE));
    expect(await screen.findByText("Account created! Here's your ID:")).toBeTruthy();
  });

  it("too many tries and an SMS service that is down say so, and keep the code pane", async () => {
    onFlow();
    answer({
      [SEND]: [accepted],
      [VERIFY]: [refused(429, "rate_limited"), refused(503, "verification_unavailable")],
    });
    await sendCode();

    await act(async () => fireEvent.changeText(codeField(), CODE));
    expect(await screen.findByText("Too many attempts. Try again in a moment.")).toBeTruthy();

    await act(async () => fireEvent.press(button("Verify")));
    expect(
      await screen.findByText("We couldn't send or check the code right now. Try again soon."),
    ).toBeTruthy();
    expect(screen.getByText("Enter the code we sent")).toBeTruthy();
    expect(endOnboarding).not.toHaveBeenCalled();
  });

  it("Resend waits its time from the code sent, then sends a new one", async () => {
    jest.useFakeTimers();
    onFlow();
    answer({ [SEND]: [accepted, accepted] });
    await sendCode();
    const { resendSeconds } = phoneConfig;
    const resend = () => screen.getByTestId("sign-up-resend");

    expect(resend()).toHaveTextContent(`Resend in ${resendSeconds} s`);
    expect(resend().props.accessibilityState).toMatchObject({ disabled: true });

    await act(async () => jest.advanceTimersByTime(resendSeconds * 1000));
    expect(resend()).toHaveTextContent("Resend code");

    await act(async () => fireEvent.press(resend()));

    expect(calls(SEND)).toHaveLength(2);
    expect(calls(SEND)[1][1]).toEqual({ phone: E164 });
    await waitFor(() => expect(resend()).toHaveTextContent(`Resend in ${resendSeconds} s`));
  });

  it("Change number and Back return to the number, kept as typed; a new code starts over", async () => {
    jest.useFakeTimers();
    onFlow();
    answer({ [SEND]: [accepted, accepted] });
    await sendCode();
    await act(async () => fireEvent.changeText(codeField(), "12"));
    await act(async () => jest.advanceTimersByTime(10_000));

    await act(async () => fireEvent.press(button("Change number")));

    await arrive("What's your number?");
    expect(numberField().props.value).toBe("(415) 555-0123");
    expect(phoneFlowStore.getState().pendingNumber).toBeNull();

    await act(async () => fireEvent.press(button("Send code")));
    await arrive("Enter the code we sent");
    expect(codeField().props.value).toBe("");
    expect(screen.getByTestId("sign-up-resend")).toHaveTextContent(
      `Resend in ${phoneConfig.resendSeconds} s`,
    );

    // A system Back on the code pane goes to the number too, never a step further.
    await act(async () => mockGuard.onBlocked());
    await arrive("What's your number?");
    await act(async () => mockGuard.onBlocked());
    expect(await arrive("Let's see that face!")).toBeTruthy();
  });
});

describe("SignUpScreen: resuming around the phone", () => {
  it("a number on the account that is not verified resumes on the phone step", async () => {
    onFlow({ ...photographed, phone: E164, phone_verified: false });
    await renderFlow();

    expect(screen.getByText("What's your number?")).toBeTruthy();
    expect(endOnboarding).not.toHaveBeenCalled();
  });

  it("every step answered opens on the finished card; Let's go opens the app", async () => {
    onFlow(VERIFIED);
    await renderFlow();

    expect(await screen.findByText("Account created! Here's your ID:")).toBeTruthy();
    expect(card()).toBe(`Ana Cruz|${SHOWN}`);
    expect(endOnboarding).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(button("Let's go")));

    await waitFor(() => expect(endOnboarding).toHaveBeenCalledTimes(1));
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("SignUpScreen: a late answer", () => {
  it("a code checked as the flow is left changes nothing", async () => {
    onFlow();
    const check = deferred<SessionUser>();
    answer({ [SEND]: [accepted], [VERIFY]: [() => check.promise] });
    await sendCode();
    await act(async () => fireEvent.changeText(codeField(), CODE));

    await act(async () => screen.unmount());
    await act(async () => check.resolve(VERIFIED));

    expect(sessionStore.getState().user?.phone_verified).toBe(false);
    expect(phoneFlowStore.getState().pendingNumber).toBeNull();
  });

  it("a code typed after another sign-in is not checked with that account's token (#292 Vault B1)", async () => {
    onFlow();
    answer({ [SEND]: [accepted] });
    await sendCode();
    expect(calls(SEND)[0]?.[2]).toMatchObject({ generation: sessionGeneration() });
    // The real client from here, so the pinned check is refused where it would be sent.
    jest.mocked(apiPost).mockImplementation(sentPost);
    const fetch = installFetchMock();
    const second = { ...user, id: "22222222-2222-4222-8222-222222222222" };
    fetch.mockImplementation(async (url) =>
      url.endsWith("/v1/auth/login")
        ? jsonResponse(200, { ...authResponse(2), user: second })
        : jsonResponse(200, { ...second, phone_verified: true }),
    );
    await act(() => login({ email: "b@example.invalid", password: "synthetic test password" }));

    await act(async () => fireEvent.changeText(codeField(), CODE));

    expect(callsTo(fetch, VERIFY)).toHaveLength(0);
    expect(screen.queryByText("Account created! Here's your ID:")).toBeNull();
    expect(endOnboarding).not.toHaveBeenCalled();
    expect(sessionStore.getState().user).toMatchObject({ id: second.id, phone_verified: false });
  });
});
