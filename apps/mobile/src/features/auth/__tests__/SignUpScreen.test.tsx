import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo } from "react-native";

import {
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
  endOnboarding,
  NetworkError,
  register,
  type SessionUser,
} from "@/api";

import { deferred, user } from "../../../api/__tests__/helpers";
import { sessionStore } from "../../../api/session";
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
  register: jest.fn(),
  apiPatch: jest.fn(),
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  // The flow ends only once nothing blocks leaving: the gate's switch to the app must not be
  // refused by the screen's own guard.
  endOnboarding: jest.fn(async () => {
    if (mockGuard.on) throw new Error("ended while the screen still blocks leaving");
  }),
}));
// The last guard the screen set: whether it blocks leaving, and what a blocked Back does.
const mockGuard = { on: false, onBlocked: (): void => undefined };
jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: jest.fn(() => {
      if (mockGuard.on) throw new Error("left while the screen still blocks leaving");
    }),
    canGoBack: jest.fn(() => true),
  },
  useLocalSearchParams: jest.fn(() => ({ role: "pro" })),
  Redirect: jest.fn(() => null),
  usePreventRemove: jest.fn((on: boolean, onBlocked: () => void) => {
    mockGuard.on = on;
    mockGuard.onBlocked = onBlocked;
  }),
}));
// Every timing ends at once and reports it: a step's slide settles inside the test (after the
// slider's wait for the arriving pane's layout, which Jest never sends).
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
  IdCard: ({ variant, name, city, state }: Record<string, string | undefined>) => {
    const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
    return <Text testID="card">{`${variant}|${name ?? ""}|${city ?? ""}|${state ?? ""}`}</Text>;
  },
}));

const card = () => screen.getByTestId("card").props.children as string;
const button = (name: string) => screen.getByRole("button", { name });
const field = (label: string) => screen.getByLabelText(label);
const bubble = (name: "email" | "password") => screen.getByTestId(`sign-up-screen-${name}-bubble`);

/** The account in the session store, signed in and on its flow, as `register` leaves it. */
function signIn(account: SessionUser) {
  sessionStore.setState({
    status: "signedIn",
    user: account,
    accessToken: "access",
    accessTokenExpiresAt: Date.now() + 60_000,
    onboardingUserId: account.id,
  });
}

/** PATCH /v1/auth/me answers with the account as changed. */
function patchesMe() {
  jest.mocked(apiPatch).mockImplementation(async (_path, body) => ({
    ...(sessionStore.getState().user as SessionUser),
    ...(body as object),
  }));
}

/** The step titled `title` is on screen and its slide is over: its action and fields take input. */
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
  return renderInSafeArea(
    <QueryClientProvider client={client}>
      <SignUpScreen />
    </QueryClientProvider>,
  );
}

async function createAccount(address = "maria@example.com", secret = "correct horse battery") {
  await fireEvent.changeText(field("Email"), address);
  await fireEvent.changeText(field("Password"), secret);
  await fireEvent.press(button("Create account"));
}

async function enterNames(first: string, last: string) {
  await fireEvent.changeText(field("First name"), first);
  await fireEvent.changeText(field("Last name"), last);
}

let announce: jest.SpyInstance;
let announceQueued: jest.SpyInstance;

beforeEach(() => {
  mockGuard.on = false;
  sessionStore.setState(SIGNED_OUT);
  phoneFlowStore.setState({ pendingNumber: null });
  jest.mocked(register).mockReset();
  jest.mocked(apiPatch).mockReset();
  jest.mocked(apiPost).mockReset();
  jest.mocked(apiGet).mockReset();
  jest.mocked(endOnboarding).mockClear();
  jest.mocked(router.replace).mockClear();
  jest.mocked(router.back).mockClear();
  jest.mocked(router.dismissTo).mockClear();
  jest.mocked(Redirect).mockClear();
  jest.mocked(useLocalSearchParams).mockReturnValue({ role: "pro" });
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  announceQueued = jest
    .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  announce.mockRestore();
  announceQueued.mockRestore();
});

describe("SignUpScreen: the account step", () => {
  it("creates the account on its flow with the role and device locale, then asks for the name", async () => {
    jest.mocked(register).mockImplementation(async () => signIn({ ...user, role: "pro" }));
    await renderFlow();
    expect(screen.getByText("Let's start with your email")).toBeTruthy();
    expect(screen.getByText("As a pro")).toBeTruthy();
    expect(screen.getByLabelText("Step 1 of 5")).toBeTruthy();
    expect(card()).toBe("pro|||"); // blank while the account is made

    await createAccount("  Maria@Example.com ");

    expect(register).toHaveBeenCalledWith(
      { email: "maria@example.com", password: "correct horse battery", role: "pro", locale: "en" },
      { onboarding: true },
    );
    expect(await arrive("Tell us your name!")).toBeTruthy();
    expect(screen.getByLabelText("Step 2 of 5")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("checks email and password on the device before any request", async () => {
    await renderFlow();

    await createAccount("not-an-email", "short");

    expect(screen.getByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText("Use at least 10 characters.")).toBeTruthy();
    expect(bubble("email").props.className).toContain("border-danger");
    expect(register).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("Enter a valid email address.");
  });

  it.each([
    [422, "validation_error", "Check the highlighted fields."],
    [429, "rate_limited", "Too many attempts. Try again in a moment."],
    [500, "internal_error", "Something went wrong. Try again."],
  ])("maps %s %s to its message, with no raw server text", async (status, code, message) => {
    jest.mocked(register).mockRejectedValue(new ApiError(status, code));
    await renderFlow();

    await createAccount();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(message);
    expect(screen.getByText("Let's start with your email")).toBeTruthy();
  });

  it("an email already registered offers to log in instead", async () => {
    jest.mocked(register).mockRejectedValue(new ApiError(409, "email_already_registered"));
    await renderFlow();

    await createAccount();

    expect(await screen.findByText("An account with this email already exists.")).toBeTruthy();
    await fireEvent.press(button("Log in instead"));
    expect(router.replace).toHaveBeenCalledWith("/(auth)/login");
  });

  it("nothing leaves while the account is being created; after a failure Back works again", async () => {
    const pending = deferred<void>();
    jest.mocked(register).mockReturnValue(pending.promise);
    await renderFlow();
    expect(mockGuard.on).toBe(false);

    await createAccount();

    expect(await screen.findByRole("button", { name: "Create account, Loading" })).toBeTruthy();
    expect(field("Email").props.editable).toBe(false);
    expect(mockGuard.on).toBe(true);
    await act(async () => pending.reject(new NetworkError(false)));
    expect(
      await screen.findByText("No connection. Check your internet and try again."),
    ).toBeTruthy();
    expect(mockGuard.on).toBe(false);
  });

  it("without a valid role it goes back to the role choice", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({ role: "admin" });
    await renderFlow();

    expect(Redirect).toHaveBeenCalledWith(
      expect.objectContaining({ href: "/(auth)/role" }),
      undefined,
    );
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});

describe("SignUpScreen: the name step", () => {
  beforeEach(() =>
    jest.mocked(register).mockImplementation(async () => signIn({ ...user, role: "pro" })),
  );

  async function reachName() {
    await renderFlow();
    await createAccount();
    await arrive("Tell us your name!");
  }

  it("types the name into the card live and saves it, tidied, with PATCH /v1/auth/me", async () => {
    patchesMe();
    await reachName();

    await fireEvent.changeText(field("First name"), " Ana ");
    expect(card()).toBe("pro|Ana||");
    await fireEvent.changeText(field("Last name"), "de  la Cruz");
    expect(card()).toBe("pro|Ana de  la Cruz||");

    await fireEvent.press(button("Continue"));

    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/auth/me",
      { first_name: "Ana", last_name: "de la Cruz" },
      { auth: true },
    );
    expect(await arrive("Where do you live?")).toBeTruthy();
    expect(sessionStore.getState().user?.first_name).toBe("Ana");
  });

  it("asks for both names before any request", async () => {
    await reachName();

    await enterNames("Ana", "  ");
    await fireEvent.press(button("Continue"));

    expect(screen.getByText("Fill in this field.")).toBeTruthy();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(screen.getByText("Tell us your name!")).toBeTruthy();
  });

  it.each([
    [
      new ApiError(422, "validation_error"),
      "Use letters, spaces, hyphens, apostrophes or periods.",
    ],
    [new NetworkError(false), "No connection. Check your internet and try again."],
    [new ApiError(500, "internal_error"), "We couldn't save your name. Try again."],
  ])("a refused or failed save stays on the step: %p", async (error, message) => {
    jest.mocked(apiPatch).mockRejectedValue(error);
    await reachName();

    await enterNames("Ana", "Cruz");
    await fireEvent.press(button("Continue"));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(announceQueued).toHaveBeenCalledWith(message, { queue: true });
    expect(screen.getByText("Tell us your name!")).toBeTruthy();
  });

  it("has no way back: the Back row is hidden and a system Back stays on the step", async () => {
    await reachName();

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    // Out of sight too, not only out of reach (the steps' fade wraps it, never overrides it).
    expect(screen.getByTestId("sign-up-back-row", { includeHiddenElements: true })).toHaveStyle({
      opacity: 0,
    });
    expect(mockGuard.on).toBe(true);
    await act(async () => mockGuard.onBlocked());
    expect(screen.getByText("Tell us your name!")).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe("SignUpScreen: the home step", () => {
  async function reachHome(role: "customer" | "pro") {
    jest.mocked(useLocalSearchParams).mockReturnValue({ role });
    jest.mocked(register).mockImplementation(async () => signIn({ ...user, role }));
    patchesMe();
    await renderFlow();
    await createAccount();
    await arrive("Tell us your name!");
    await enterNames("Ana", "Cruz");
    await fireEvent.press(button("Continue"));
    await arrive("Where do you live?");
    jest.mocked(apiPatch).mockClear();
  }

  async function typeAddress() {
    await fireEvent.changeText(field("Street address"), " 120 Main St ");
    await fireEvent.changeText(field("City"), "Miami ");
    await fireEvent.changeText(field("State"), "fl");
    await fireEvent.changeText(field("ZIP code"), "33101");
  }

  it("a customer's address is saved as Home, then the card's city and state; the selfie is next", async () => {
    await reachHome("customer");
    jest.mocked(apiPost).mockResolvedValue({} as never);
    expect(screen.getByLabelText("Step 3 of 5")).toBeTruthy();

    await typeAddress();
    expect(card()).toBe("customer|Ana Cruz|Miami|FL");
    await fireEvent.press(button("Continue"));

    expect(await arrive("Let's see that face!")).toBeTruthy();
    expect(screen.getByLabelText("Step 4 of 5")).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith(
      "/v1/addresses",
      {
        line1: "120 Main St",
        city: "Miami",
        state: "FL",
        zip_code: "33101",
        label: "Home",
        is_default: true,
      },
      { auth: true },
    );
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/auth/me",
      { home_city: "Miami", home_state: "FL" },
      { auth: true },
    );
    expect(jest.mocked(apiPost).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(apiPatch).mock.invocationCallOrder[0],
    );
    // The flow goes on: nothing ends and nothing leaves.
    expect(endOnboarding).not.toHaveBeenCalled();
    expect(mockGuard.on).toBe(true);
  });

  it("a Home saved by an earlier try (409) is updated with what was typed, then the card", async () => {
    await reachHome("customer");
    jest.mocked(apiPost).mockRejectedValue(new ApiError(409, "address_label_taken"));
    jest.mocked(apiGet).mockResolvedValue({
      items: [{ id: "home-1", label: "home", line1: "1 Old Rd", city: "Tampa", state: "FL" }],
    } as never);

    await typeAddress();
    await fireEvent.press(button("Continue"));

    await arrive("Let's see that face!");
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/addresses/{address_id}",
      {
        line1: "120 Main St",
        line2: null,
        city: "Miami",
        state: "FL",
        zip_code: "33101",
        is_default: true,
      },
      { auth: true, params: { address_id: "home-1" } },
    );
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/auth/me",
      { home_city: "Miami", home_state: "FL" },
      { auth: true },
    );
  });

  it("a pro gives the city and state only, saved on the account alone", async () => {
    await reachHome("pro");
    expect(screen.queryByLabelText("Street address")).toBeNull();
    expect(screen.queryByLabelText("ZIP code")).toBeNull();
    expect(screen.getByText("Your card shows only the city and state.")).toBeTruthy();

    await fireEvent.changeText(field("City"), "Orlando");
    await fireEvent.changeText(field("State"), "fl");
    await fireEvent.press(button("Continue"));

    await arrive("Let's see that face!");
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/auth/me",
      { home_city: "Orlando", home_state: "FL" },
      { auth: true },
    );
  });

  it("a state that is not a US state or DC code is caught before any request", async () => {
    await reachHome("pro");

    await fireEvent.changeText(field("City"), "Toronto");
    await fireEvent.changeText(field("State"), "ON");
    await fireEvent.press(button("Continue"));

    expect(screen.getByText("Use the two-letter code, like FL.")).toBeTruthy();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(endOnboarding).not.toHaveBeenCalled();
  });

  it("a failed save keeps the step, with what was typed", async () => {
    await reachHome("customer");
    jest.mocked(apiPost).mockRejectedValue(new ApiError(422, "validation_error"));

    await typeAddress();
    await fireEvent.press(button("Continue"));

    expect(
      await screen.findByText("We couldn't use this address. Check the fields and try again."),
    ).toBeTruthy();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(field("City").props.value).toBe("Miami ");
    expect(endOnboarding).not.toHaveBeenCalled();
  });

  it("Back (the button or the system's) returns to the name, kept as typed", async () => {
    await reachHome("pro");

    await fireEvent.press(button("Back"));
    expect(await arrive("Tell us your name!")).toBeTruthy();
    expect(field("First name").props.value).toBe("Ana");

    // A double tap: the second press meets the home step while it slides in, and is ignored.
    await fireEvent.press(button("Continue"));
    await fireEvent.press(button("Continue"));
    await arrive("Where do you live?");
    expect(apiPatch).not.toHaveBeenCalled(); // the names did not change
    expect(screen.queryByText("Fill in this field.")).toBeNull();
    await act(async () => mockGuard.onBlocked());
    expect(await arrive("Tell us your name!")).toBeTruthy();
  });
});

describe("SignUpScreen: resume", () => {
  function onFlow(account: SessionUser) {
    signIn(account);
    // A relaunch lands here from the gate's redirect, with no role in the route.
    jest.mocked(useLocalSearchParams).mockReturnValue({});
  }

  it("opens at the first unfinished step, in the account's role", async () => {
    onFlow({ ...user, role: "pro", first_name: "Ana", last_name: "Cruz" });

    await renderFlow();

    expect(screen.getByText("Where do you live?")).toBeTruthy();
    expect(screen.getByLabelText("Step 3 of 5")).toBeTruthy();
    expect(card()).toBe("pro|Ana Cruz||");
    expect(screen.queryByLabelText("Street address")).toBeNull();
  });

  it("an account without a name resumes on the name step", async () => {
    onFlow(user);

    await renderFlow();

    expect(screen.getByText("Tell us your name!")).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });

  it("a session that ends mid-flow goes back to Welcome, unguarded", async () => {
    onFlow(user);
    await renderFlow();
    expect(mockGuard.on).toBe(true);

    await act(async () => sessionStore.setState(SIGNED_OUT));

    expect(router.dismissTo).toHaveBeenCalledWith("/(auth)/welcome");
    expect(mockGuard.on).toBe(false);
  });
});
