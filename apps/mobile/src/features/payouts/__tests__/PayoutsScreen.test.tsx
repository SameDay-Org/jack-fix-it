import "@/i18n";

import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import {
  dismissAuthSession,
  openAuthSessionAsync,
  type WebBrowserAuthSessionResult,
} from "expo-web-browser";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { ApiError, apiGet, apiPost, NetworkError, useSession } from "@/api";

import { deferred, settle } from "../../../api/__tests__/helpers";
import type { ProProfile } from "../../pro-profile";
import { myProProfileQueryKey } from "../../pro-profile/api";
import { FULL_PROFILE } from "../../pro-profile/__tests__/helpers";
import type { Payouts } from "../api";
import { PayoutsScreen } from "../PayoutsScreen";

import {
  link,
  LINK_MARK,
  navigation,
  newQueryClient,
  ONBOARDING_LINK,
  PAYOUTS,
  payouts,
  PROFILE,
  REFRESH_LINK,
  renderWithQuery,
  RETURN_LINK,
  SETUP_LINK,
  signedIn,
} from "./helpers";

jest.mock("@/api", () => jest.requireActual("./helpers").apiMock());
jest.mock("expo-router", () => {
  const { routerMock, navigation: nav } =
    jest.requireActual<typeof import("./helpers")>("./helpers");
  // The screen clears the link's param on its own route: recorded, then applied.
  const own = { setParams: jest.fn((_params: Record<string, unknown>) => nav.setParams({})) };
  return { ...routerMock, useNavigation: () => own, mockOwnNavigation: own };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// Reduce Motion on: the loading skeleton's endless pulse would otherwise keep the run busy.
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  ...jest.requireActual<typeof import("react-native-reanimated")>("react-native-reanimated"),
  useReducedMotion: jest.fn(() => true),
}));

const APPROVED: ProProfile = { ...FULL_PROFILE, verification_status: "approved" };
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** The screen's own route, as `useNavigation` hands it out (see the mock above). */
const ownRoute = () =>
  jest.requireMock<{ mockOwnNavigation: { setParams: jest.Mock } }>("expo-router")
    .mockOwnNavigation;

/** What the API answers now, by path; an Error is thrown, a promise is awaited. */
let server: {
  payouts: Payouts | Error | Promise<Payouts>;
  profile: ProProfile | Error;
  link: unknown;
};
let client: QueryClient;
let consoleSpies: jest.SpyInstance[];

const flush = () => act(async () => settle());
const pressed = (testID: string) => act(async () => fireEvent.press(screen.getByTestId(testID)));
const asked = (path: string) =>
  jest.mocked(apiGet).mock.calls.filter(([called]) => (called as string) === path).length;
const message = () => screen.getByTestId("payouts-message");
const setupButton = () => screen.getByTestId("payouts-setup");
const browserReturns = (url: string) =>
  jest.mocked(openAuthSessionAsync).mockResolvedValueOnce({ type: "success", url });
/** The app comes back to the foreground: what the screen's AppState listener hears. */
const foreground = async () => {
  const onChange = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as (
    state: AppStateStatus,
  ) => void;
  await act(async () => onChange("background"));
  await act(async () => onChange("active"));
};

/**
 * An Error serialises to `{}`: spelled out here, with its cause, so the sentinel would see a link
 * kept in an error's message or stack.
 */
function spellErrors(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return { name: value.name, message: value.message, stack: value.stack, cause: value.cause };
}

/**
 * Everything the app holds after a link was used: the caches (errors included), the screen, the
 * logs, and every route the screen pushed or param it set.
 */
function everythingKept(): string {
  return JSON.stringify(
    {
      queries: client
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state]),
      mutations: client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
      screen: screen.toJSON(),
      logs: consoleSpies.flatMap((spy) => spy.mock.calls),
      routes: [jest.mocked(router.push).mock.calls, ownRoute().setParams.mock.calls],
    },
    spellErrors,
  );
}

async function open(status: Payouts | Error, profile: ProProfile | Error = APPROVED) {
  server = { payouts: status, profile, link: link() };
  await renderWithQuery(<PayoutsScreen />, client);
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
  navigation.setParams({});
  client = newQueryClient();
  consoleSpies = CONSOLE_METHODS.map((method) => jest.spyOn(console, method));
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockImplementation((async (path: string) => {
    const answer = path === PAYOUTS ? server.payouts : server.profile;
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof apiGet);
  jest.mocked(apiPost).mockImplementation((async () => {
    if (server.link instanceof Error) throw server.link;
    return server.link;
  }) as unknown as typeof apiPost);
});

afterEach(async () => {
  await flush();
  consoleSpies.forEach((spy) => spy.mockRestore());
});

describe("PayoutsScreen: where the payout account stands", () => {
  it("Not set up: says what Stripe will ask for and who sees it, then one button", async () => {
    await open(payouts("not_started"));

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("Not set up");
    expect(message()).toHaveTextContent(
      "Set up how you get paidJack Fix It pays you through Stripe. You need a payout account before requests can reach you.",
    );
    expect(screen.getByTestId("payouts-asks")).toHaveTextContent(
      "What Stripe will ask forA bank account, where your payouts goYour identity, to confirm it's youStripe collects and keeps these details. Jack Fix It never sees them.",
    );
    expect(screen.getByRole("button", { name: "Set up payouts" })).toBeTruthy();
    // Opening the screen asks for the status and for no link.
    expect(apiPost).not.toHaveBeenCalled();
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it("In progress: Stripe needs more, and the button continues", async () => {
    await open(payouts("incomplete"));

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
    expect(message()).toHaveTextContent(
      "Stripe needs more informationPick up where you left off to turn on payouts.",
    );
    expect(screen.getByRole("button", { name: "Continue setup" })).toBeTruthy();
    expect(screen.queryByTestId("payouts-asks")).toBeNull();
  });

  it("In review: nothing to set up, no date promised, and a way to check again", async () => {
    await open(payouts("in_review"));

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In review");
    expect(message()).toHaveTextContent(
      "Stripe is reviewing your detailsEverything is in. The result shows up here; there's nothing else to do for now.",
    );
    expect(message()).not.toHaveTextContent(/hour|day|soon|minute/i);
    expect(screen.queryByTestId("payouts-setup")).toBeNull();

    server.payouts = payouts("enabled");
    await pressed("payouts-check");
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
  });

  it.each([
    [
      "an approved pro can receive requests",
      APPROVED,
      "You can receive requests. New ones near you show up on Home.",
    ],
    [
      "a pro still in review is told requests wait for the approval",
      FULL_PROFILE,
      "You're set to get paid. Requests reach you once your verification is approved.",
    ],
    [
      "with no profile to go by, nothing is said about requests",
      new ApiError(500, "internal_error"),
      "You're set to get paid for your jobs.",
    ],
  ])("On: %s", async (_name, profile, line) => {
    await open(payouts("enabled"), profile);

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
    await waitFor(() =>
      expect(screen.getByTestId("payouts-enabled")).toHaveTextContent(`Payouts are on${line}`),
    );
    expect(screen.queryByTestId("payouts-setup")).toBeNull();
    expect(screen.queryByTestId("payouts-check")).toBeNull();
  });

  it("shows a placeholder while the status loads", async () => {
    const answer = deferred<Payouts>();
    server = { payouts: payouts("not_started"), profile: APPROVED, link: link() };
    jest.mocked(apiGet).mockImplementationOnce((() => answer.promise) as unknown as typeof apiGet);
    await renderWithQuery(<PayoutsScreen />, client);

    expect(screen.getByLabelText("Loading your payout status")).toBeTruthy();
    expect(screen.queryByTestId("payouts-status")).toBeNull();
    expect(screen.queryByTestId("payouts-setup")).toBeNull();

    await act(async () => answer.resolve(payouts("incomplete")));
    await flush();
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
  });

  it.each([
    [
      "payments down (503)",
      new ApiError(503, "payments_unavailable"),
      "Payments are unavailable right now. Try again in a moment.",
    ],
    [
      "Stripe refused (502)",
      new ApiError(502, "payments_error"),
      "Payments are unavailable right now. Try again in a moment.",
    ],
    ["offline", new NetworkError(false), "You're offline. Check your connection and try again."],
    ["anything else", new ApiError(500, "internal_error"), "Give it another try in a moment."],
  ])(
    "a status that did not load says so calmly: %s, then loads on a retry",
    async (_n, error, line) => {
      await open(error);

      const notice = screen.getByTestId("payouts-load-failed");
      expect(notice).toHaveTextContent(`We couldn't load your payout status${line}Try again`);
      // Never the raw error, and nothing to set up from a status nobody knows.
      expect(notice).not.toHaveTextContent(/payments_|internal_|status \d|API request/);
      expect(screen.queryByTestId("payouts-setup")).toBeNull();

      server.payouts = payouts("not_started");
      await pressed("payouts-retry");
      await flush();

      expect(screen.queryByTestId("payouts-load-failed")).toBeNull();
      expect(setupButton()).toBeTruthy();
    },
  );

  it("a status that could not be asked for again stays, with a way to retry", async () => {
    await open(payouts("incomplete"));

    server.payouts = new ApiError(503, "payments_unavailable");
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await flush();

    expect(screen.getByTestId("payouts-stale-message")).toHaveTextContent(
      "We couldn't refresh your payout status.",
    );
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");

    server.payouts = payouts("in_review");
    await pressed("payouts-stale-action");
    await flush();

    expect(screen.queryByTestId("payouts-stale")).toBeNull();
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In review");
  });

  it("asks for the status again when the app returns to the foreground", async () => {
    await open(payouts("incomplete"));
    expect(asked(PAYOUTS)).toBe(1);

    const onChange = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as (
      state: AppStateStatus,
    ) => void;
    server.payouts = payouts("enabled");
    await act(async () => onChange("background"));
    await act(async () => onChange("active"));
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
  });

  it("asks nothing for anyone but a pro", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "customer" }));
    await open(payouts("not_started"));

    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId("payouts-setup")).toBeNull();
  });
});

describe("PayoutsScreen: Set up payouts", () => {
  it("asks for a link, for this session, and opens it in a browser session with the app's return link", async () => {
    await open(payouts("not_started"));
    await pressed("payouts-setup");
    await flush();

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(ONBOARDING_LINK, undefined, {
      auth: true,
      generation: 1,
      signal: expect.objectContaining({ aborted: false }),
    });
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(openAuthSessionAsync).toHaveBeenCalledWith(SETUP_LINK, "jackfixit://payouts");
  });

  it("stays busy while the browser is open: a second press opens nothing", async () => {
    const browser = deferred<WebBrowserAuthSessionResult>();
    jest.mocked(openAuthSessionAsync).mockReturnValueOnce(browser.promise);
    await open(payouts("not_started"));

    await pressed("payouts-setup");
    await pressed("payouts-setup");
    await flush();

    expect(setupButton()).toBeBusy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
    // The link is in the browser and nowhere in the app, even now.
    expect(everythingKept()).not.toContain(LINK_MARK);

    await act(async () => browser.resolve({ type: "cancel" } as WebBrowserAuthSessionResult));
    await flush();
    expect(setupButton()).not.toBeBusy();
  });

  it("two presses in one frame ask for one link", async () => {
    await open(payouts("not_started"));

    await act(async () => {
      fireEvent.press(setupButton());
      fireEvent.press(setupButton());
    });
    await flush();

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps the link nowhere once it is used: no cache, no state, no screen, no log", async () => {
    browserReturns(RETURN_LINK);
    await open(payouts("not_started"));
    server.payouts = payouts("incomplete");

    await pressed("payouts-setup");
    await flush();

    expect(openAuthSessionAsync).toHaveBeenCalledWith(SETUP_LINK, "jackfixit://payouts");
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
    // The sentinel is the link's host, path and account id: none of it is anywhere.
    expect(everythingKept()).not.toContain(LINK_MARK);
    // What the cache does hold: the status, and nothing shaped like a link.
    expect(everythingKept()).not.toMatch(/https?:\/\//);
  });

  it("back through the return page: the status is asked for again, and payouts on shows", async () => {
    browserReturns(RETURN_LINK);
    await open(payouts("not_started"));
    client.setQueryData(myProProfileQueryKey(1), APPROVED);
    const profileAsks = asked(PROFILE);
    server.payouts = payouts("enabled");
    server.profile = { ...APPROVED, payouts_enabled: true };

    await pressed("payouts-setup");
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
    // The profile said payouts were off: it is asked for again, which is what opens the home.
    await waitFor(() =>
      expect(client.getQueryData<ProProfile>(myProProfileQueryKey(1))?.payouts_enabled).toBe(true),
    );
    expect(asked(PROFILE)).toBeGreaterThan(profileAsks);
    expect(screen.getByTestId("payouts-enabled")).toHaveTextContent(
      "Payouts are onYou can receive requests. New ones near you show up on Home.",
    );
  });

  it("closing the browser asks for the status again too", async () => {
    await open(payouts("not_started"));
    server.payouts = payouts("incomplete");

    await pressed("payouts-setup");
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByRole("button", { name: "Continue setup" })).toBeTruthy();
    expect(screen.queryByTestId("payouts-expired")).toBeNull();
  });

  it("back through the refresh page: the link expired, and the next press opens a new one", async () => {
    browserReturns(REFRESH_LINK);
    await open(payouts("incomplete"));

    await pressed("payouts-setup");
    await flush();

    expect(screen.getByTestId("payouts-expired")).toHaveTextContent(
      "That setup page expiredOpen a new one to pick up where you left off.",
    );
    // No second link by itself: each one is a rate-limited Stripe call.
    expect(apiPost).toHaveBeenCalledTimes(1);

    await pressed("payouts-setup");
    await flush();

    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("payouts-expired")).toBeNull();
  });

  it.each([
    [
      "too many links (429)",
      new ApiError(429, "rate_limited"),
      "payouts-failure-busy",
      "Give it a momentYou've opened the setup page a few times in a row. Try again in a moment.",
    ],
    [
      "payments down (503)",
      new ApiError(503, "payments_unavailable"),
      "payouts-failure-unavailable",
      "Payout setup is unavailable right nowNothing was changed. Try again in a moment.",
    ],
    [
      "Stripe refused (502)",
      new ApiError(502, "payments_error"),
      "payouts-failure-unavailable",
      "Payout setup is unavailable right nowNothing was changed. Try again in a moment.",
    ],
    [
      "offline",
      new NetworkError(false),
      "payouts-failure-offline",
      "You're offlineCheck your connection and try again.",
    ],
    [
      "anything else",
      new ApiError(500, "internal_error"),
      "payouts-failure-generic",
      "We couldn't open payout setupGive it another try in a moment.",
    ],
  ])("a link that was refused says so calmly: %s", async (_name, error, testID, text) => {
    await open(payouts("not_started"));
    server.link = error;

    await pressed("payouts-setup");
    await flush();

    const notice = screen.getByTestId(testID);
    expect(notice).toHaveTextContent(text);
    expect(screen.getByTestId("payouts-screen")).not.toHaveTextContent(
      /rate_limited|payments_|internal_|status \d|API request/,
    );
    // No link, no browser; the button is there for the next try, which clears the notice.
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
    expect(setupButton()).not.toBeBusy();

    server.link = link();
    await pressed("payouts-setup");
    await flush();
    expect(screen.queryByTestId(testID)).toBeNull();
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
  });

  it("an account that needs a review (409) sends the pro to support", async () => {
    await open(payouts("not_started"));
    server.link = new ApiError(409, "payouts_needs_review");

    await pressed("payouts-setup");
    await flush();

    expect(screen.getByTestId("payouts-failure-review")).toHaveTextContent(
      "Your payout account needs a reviewOur support team has to take a look before you can go on. Contact us so we can help.Contact support",
    );
    expect(openAuthSessionAsync).not.toHaveBeenCalled();

    await pressed("payouts-contact");
    expect(router.push).toHaveBeenCalledWith("/help/contact");
  });

  it("another 409 is not read as a review", async () => {
    await open(payouts("not_started"));
    server.link = new ApiError(409, "conflict");

    await pressed("payouts-setup");
    await flush();

    expect(screen.getByTestId("payouts-failure-generic")).toBeTruthy();
    expect(screen.queryByTestId("payouts-contact")).toBeNull();
  });

  it("a browser that would not open says so, and the link is still kept nowhere", async () => {
    // The browser's own error quotes the link: the app keeps none of it, not even in an error.
    jest
      .mocked(openAuthSessionAsync)
      .mockRejectedValueOnce(new Error(`no browser for ${SETUP_LINK}`));
    await open(payouts("not_started"));

    await pressed("payouts-setup");
    await flush();

    expect(screen.getByTestId("payouts-failure-generic")).toHaveTextContent(
      "We couldn't open payout setupGive it another try in a moment.",
    );
    expect(client.getMutationCache().getAll()[0]?.state.error).toBeInstanceOf(Error);
    expect(everythingKept()).not.toContain(LINK_MARK);
  });

  it("stays busy until the status is back: the old one never shows with the button free", async () => {
    browserReturns(RETURN_LINK);
    await open(payouts("not_started"));
    const status = deferred<Payouts>();
    server.payouts = status.promise;

    await pressed("payouts-setup");
    await flush();

    // The browser is closed and the status is still on its way: the press is not over.
    expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(asked(PAYOUTS)).toBe(2);
    expect(setupButton()).toBeBusy();

    await act(async () => status.resolve(payouts("incomplete")));
    await flush();

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
    expect(setupButton()).not.toBeBusy();
  });

  it("back to the foreground and back from the browser at once: one status request", async () => {
    const browser = deferred<WebBrowserAuthSessionResult>();
    jest.mocked(openAuthSessionAsync).mockReturnValueOnce(browser.promise);
    await open(payouts("not_started"));

    await pressed("payouts-setup");
    await flush();
    // The app comes to the front first (its status request is still on its way)...
    const status = deferred<Payouts>();
    server.payouts = status.promise;
    await foreground();
    expect(asked(PAYOUTS)).toBe(2);
    // ...then the browser session answers: the request under way is joined, not started again.
    await act(async () => browser.resolve({ type: "success", url: RETURN_LINK }));
    await act(async () => status.resolve(payouts("enabled")));
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
  });

  it("a status request under way when the page opens is cancelled: its answer predates the setup", async () => {
    await open(payouts("not_started"));
    const stale = deferred<Payouts>();
    server.payouts = stale.promise;
    await foreground();
    expect(asked(PAYOUTS)).toBe(2);
    server.payouts = payouts("incomplete");
    browserReturns(RETURN_LINK);

    await pressed("payouts-setup");
    await act(async () => stale.resolve(payouts("not_started")));
    await flush();

    // The answer from before the page opened is dropped; the one asked after it shows.
    expect(asked(PAYOUTS)).toBe(3);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
  });
});

describe("PayoutsScreen: leaving while a setup is under way", () => {
  it("a link not answered yet is cancelled, and opens nothing once it arrives", async () => {
    const answer = deferred<unknown>();
    jest.mocked(apiPost).mockReturnValueOnce(answer.promise as ReturnType<typeof apiPost>);
    await open(payouts("not_started"));

    await pressed("payouts-setup");
    const options = jest.mocked(apiPost).mock.calls[0]?.[2] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);

    await screen.unmount();
    expect(options.signal.aborted).toBe(true);
    // The answer arrives anyway (the request was already sent): nothing opens over the next screen.
    await act(async () => answer.resolve(link()));
    await flush();

    expect(openAuthSessionAsync).not.toHaveBeenCalled();
    expect(dismissAuthSession).not.toHaveBeenCalled();
  });

  it.each([
    ["ios", 1],
    ["android", 0],
  ] as const)(
    "a page already open is closed where the system allows it: %s",
    async (os, closed) => {
      const platform = jest.replaceProperty(Platform, "OS", os);
      const browser = deferred<WebBrowserAuthSessionResult>();
      jest.mocked(openAuthSessionAsync).mockReturnValueOnce(browser.promise);
      await open(payouts("not_started"));
      await pressed("payouts-setup");
      await flush();
      expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);

      await screen.unmount();

      expect(dismissAuthSession).toHaveBeenCalledTimes(closed);
      await act(async () => browser.resolve({ type: "dismiss" } as WebBrowserAuthSessionResult));
      await flush();
      platform.restore();
    },
  );

  it("leaving with nothing under way closes nothing", async () => {
    await open(payouts("not_started"));

    await screen.unmount();

    expect(dismissAuthSession).not.toHaveBeenCalled();
  });
});

describe("PayoutsScreen: the return link as a route", () => {
  it("asks for the status again, once, and clears the link's param", async () => {
    await open(payouts("incomplete"));
    expect(asked(PAYOUTS)).toBe(1);

    server.payouts = payouts("enabled");
    await act(async () => navigation.setParams({ result: "return" }));
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
    expect(screen.queryByTestId("payouts-expired")).toBeNull();
    // Cleared on the screen's own route, once: a later render reads no link.
    expect(ownRoute().setParams).toHaveBeenCalledTimes(1);
    expect(ownRoute().setParams).toHaveBeenCalledWith({ result: undefined });
  });

  it("Android hands the return link to both the browser session and the router: one status request", async () => {
    await open(payouts("incomplete"));
    const status = deferred<Payouts>();
    jest.mocked(openAuthSessionAsync).mockImplementationOnce(async () => {
      // The router's copy lands first, while the session is still answering.
      server.payouts = status.promise;
      navigation.setParams({ result: "return" });
      await settle();
      return { type: "success", url: RETURN_LINK };
    });

    await pressed("payouts-setup");
    await act(async () => status.resolve(payouts("enabled")));
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("On");
  });

  it("Android: the browser reads as closed but the refresh page's link came in: expired", async () => {
    await open(payouts("incomplete"));
    jest.mocked(openAuthSessionAsync).mockImplementationOnce(async () => {
      navigation.setParams({ result: "refresh" });
      await settle();
      return { type: "dismiss" } as WebBrowserAuthSessionResult;
    });

    await pressed("payouts-setup");
    await flush();

    expect(screen.getByTestId("payouts-expired")).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(setupButton()).not.toBeBusy();
  });

  it("a cold start through it asks once: the link and the opening share the request", async () => {
    navigation.setParams({ result: "return" });
    server = { payouts: payouts("in_review"), profile: APPROVED, link: link() };
    await renderWithQuery(<PayoutsScreen />, client);
    await flush();

    expect(asked(PAYOUTS)).toBe(1);
    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In review");
  });

  it("an expired link says so and opens nothing by itself", async () => {
    await open(payouts("incomplete"));

    await act(async () => navigation.setParams({ result: "refresh" }));
    await flush();

    expect(screen.getByTestId("payouts-expired")).toBeTruthy();
    expect(asked(PAYOUTS)).toBe(2);
    expect(apiPost).not.toHaveBeenCalled();
    expect(openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it("a forged value asks for the status again and does nothing else", async () => {
    await open(payouts("incomplete"));

    await act(async () => navigation.setParams({ result: "https://evil.test" }));
    await flush();

    expect(asked(PAYOUTS)).toBe(2);
    expect(screen.queryByTestId("payouts-expired")).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("an expired link with nothing to set up says nothing, now or once there is", async () => {
    // Anyone can write the link: in review, there is no setup page that could have expired.
    await open(payouts("in_review"));

    await act(async () => navigation.setParams({ result: "refresh" }));
    await flush();
    expect(screen.queryByTestId("payouts-expired")).toBeNull();

    // Stripe asks for more later: the old link does not surface then either.
    server.payouts = payouts("incomplete");
    await pressed("payouts-check");
    await flush();

    expect(screen.getByTestId("payouts-status")).toHaveTextContent("In progress");
    expect(screen.queryByTestId("payouts-expired")).toBeNull();
  });
});
