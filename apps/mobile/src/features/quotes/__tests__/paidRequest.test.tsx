import i18n from "@/i18n";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiGet } from "@/api";
import { dismissToast } from "@/components/ui/toast";
import { customerJobQueryKey } from "@/features/jobs/api";

import { resetSecureStore, secureStoreMock } from "../../../api/__tests__/helpers";
import { refreshPermission, resetPermissionForTests } from "../../notifications/permission";
import { resetPromptDismissalForTests } from "../../notifications/promptDismissal";

import {
  ACCEPTED,
  api,
  App,
  callsTo,
  card,
  JOB,
  JOB_PATH,
  list,
  notFound,
  OTHER,
  payTestId,
  resetPayments,
  routeApi,
  SHEET,
  signOut,
  type SessionDouble,
} from "../../payments/__tests__/helpers";
import type { CustomerJob } from "../../payments/useRequestJob";
import {
  fakeClock,
  freezeClock,
  navigation,
  newQueryClient,
  renderWithQuery,
  REQUEST_ID,
} from "./helpers";

// The request's screen whole (#324): the job's notice over the quotes (#64) and the accepted
// card's payment (#59) are both real here, each with its own copy of the job.
jest.mock("@/api", () => {
  const { signedIn } = jest.requireActual<typeof import("../../home/__tests__/helpers")>(
    "../../home/__tests__/helpers",
  );
  const session = { generation: 1, forget: new Set<() => void>() };
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    mockSession: session,
    onSignOut: (forget: () => void) => {
      session.forget.add(forget);
      return () => session.forget.delete(forget);
    },
    sessionGeneration: () => session.generation,
    isCurrentGeneration: (generation: number) => generation === session.generation,
    useSession: () => signedIn({ role: "customer" }),
    useSessionGeneration: () => session.generation,
  };
});
jest.mock("expo-router", () => jest.requireActual("./helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// One instance for the component and the test (root __mocks__, see jest-root-mocks note).
jest.mock("@stripe/stripe-react-native");
jest.mock("expo-haptics");
jest.mock("expo-notifications");
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const session = jest.requireMock<{ mockSession: SessionDouble }>("@/api").mockSession;
const notifications =
  jest.requireMock<typeof import("../../../../__mocks__/expo-notifications")>("expo-notifications");
// The whole screen and a payment walked through it: the room the payment suite takes.
jest.setTimeout(30_000);

const PAY_NAME = "Pay $180.50 for the quote from María P.";
const FOLLOW = "Follow your job";
const JOB_HREF = { pathname: "/requests/[id]/job", params: { id: REQUEST_ID } };
const paidState = () => screen.queryAllByTestId(`${payTestId(ACCEPTED)}-paid`);
/** Every text on the screen that says the job is booked, in either language. */
const bookedTexts = () => screen.queryAllByText(/booked|reserva/i);
const PROMPT = `${payTestId(ACCEPTED)}-notifications`;
const PROMPT_BODY = "Get updates when your pro is on the way.";
const DISMISSED_KEY = "jackfixit.notifications.promptDismissed";
/** The system prompt can still be shown: the pre-prompt's own condition (#334). */
const askable = () =>
  act(async () => {
    await refreshPermission();
  });
const cardButtons = () =>
  card(ACCEPTED)
    .getAllByRole("button")
    .map((button) => button.props.accessibilityLabel);

beforeEach(() => {
  freezeClock();
  navigation.reset();
  resetPayments();
  session.generation = 1;
  api.quotes = () => Promise.resolve(list([ACCEPTED, OTHER]));
  api.job = () => Promise.resolve(JOB);
  api.payment = () => Promise.resolve(SHEET);
  routeApi();
  jest.mocked(router.push).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  // Until a test reads it, the permission is unknown and the pre-prompt stays away.
  notifications.resetNotificationsMock();
  resetPermissionForTests();
  resetPromptDismissalForTests();
  resetSecureStore();
});

afterEach(async () => {
  dismissToast();
  jest.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe("a paid request says it is booked once (#324)", () => {
  it("one booked notice with the one way to the job, and a short Paid on the card", async () => {
    await renderWithQuery(<App />);

    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    // Said once on the whole screen: the notice's title, and nothing on the card.
    expect(bookedTexts()).toHaveLength(1);
    expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
    expect(card(ACCEPTED).queryByText(/booked|is set for|Scheduled/i)).toBeNull();
    expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual([
      "Your quotes",
      "Your job is booked",
    ]);

    // One Paid state, read as one label.
    expect(paidState()).toHaveLength(1);
    expect(screen.getAllByText("Paid")).toHaveLength(1);
    expect(paidState()[0].props).toMatchObject({ accessible: true, accessibilityLabel: "Paid" });

    // One link to the job, and it is the notice's: the card's only button is the pro's profile.
    expect(screen.getAllByRole("button", { name: FOLLOW })).toHaveLength(1);
    expect(cardButtons()).toEqual(["View María P.'s profile"]);
    await act(async () => fireEvent.press(screen.getByRole("button", { name: FOLLOW })));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(JOB_HREF);
    // Opening a paid request announces nothing.
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it("says the same in Spanish: one notice, 'Pagado' on the card", async () => {
    await act(() => i18n.changeLanguage("es"));
    await renderWithQuery(<App />);

    expect(await screen.findByRole("header", { name: "Tu trabajo está reservado" })).toBeTruthy();
    const paid = await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    expect(within(paid).getByText("Pagado")).toBeTruthy();
    expect(paid.props.accessibilityLabel).toBe("Pagado");
    expect(bookedTexts()).toHaveLength(1);
    expect(screen.getAllByText("Pagado")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Sigue tu trabajo" })).toHaveLength(1);
  });

  it("before the payment there is no notice and no Paid: the note and Pay, as before", async () => {
    api.job = () => Promise.reject(notFound());
    await renderWithQuery(<App />);

    await screen.findByRole("button", { name: PAY_NAME });
    expect(
      card(ACCEPTED).getByText("Quote accepted. Payment comes next.", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("job-booked")).toBeNull();
    expect(paidState()).toHaveLength(0);
    expect(bookedTexts()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: FOLLOW })).toBeNull();
  });

  it("while the payment is confirmed nothing says booked or Paid; then both land, said once", async () => {
    fakeClock();
    api.job = () => Promise.reject(notFound());
    await renderWithQuery(<App />);
    await act(async () => fireEvent.press(await screen.findByRole("button", { name: PAY_NAME })));

    // Processing, unchanged: the calm notice with its spinner, and no Pay.
    const confirming = await screen.findByTestId(`${payTestId(ACCEPTED)}-confirming`);
    expect(within(confirming).getByText("Confirming your payment…")).toBeTruthy();
    expect(within(confirming).getByText("This usually takes a few seconds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    expect(screen.queryByTestId("job-booked")).toBeNull();
    expect(paidState()).toHaveLength(0);
    expect(bookedTexts()).toHaveLength(0);

    // The webhook created the job: the card's wait finds it and hands it to the notice, which is
    // never polled and asks nothing itself (one request, the card's).
    const before = callsTo(apiGet, JOB_PATH).length;
    api.job = () => Promise.resolve(JOB);
    await act(async () => jest.advanceTimersByTime(2_000));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    expect(screen.getByRole("header", { name: "Your job is booked" })).toBeTruthy();
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(before + 1);
    expect(bookedTexts()).toHaveLength(1);
    expect(paidState()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: FOLLOW })).toHaveLength(1);
    expect(screen.queryByTestId(`${payTestId(ACCEPTED)}-confirming`)).toBeNull();
    // Spoken once, when the payment lands.
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(2);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenNthCalledWith(
      1,
      "Total $180.50. Opening the secure payment.",
    );
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenLastCalledWith(
      "You're booked. Your payment is confirmed.",
    );

    // Neither copy of the job is asked for again from here.
    const asked = callsTo(apiGet, JOB_PATH).length;
    await act(async () => jest.advanceTimersByTime(30_000));
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(asked);
  });

  it("a quote paid somewhere else: a refused Pay finds the job, and the notice with it", async () => {
    api.job = () => Promise.reject(notFound());
    api.payment = () => Promise.reject(new ApiError(409, "payment_not_available"));
    await renderWithQuery(<App />);
    const pay = await screen.findByRole("button", { name: PAY_NAME });
    expect(screen.queryByTestId("job-booked")).toBeNull();

    api.job = () => Promise.resolve(JOB);
    await act(async () => fireEvent.press(pay));

    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
    expect(bookedTexts()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: FOLLOW })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
  });

  it.each([
    ["cancelled", "This job was cancelled", false],
    ["refunded", "This job was cancelled", false],
    ["confirmed", "Job confirmed", true],
  ] as const)(
    "once the job is %s nothing says booked: the notice says where it ended",
    async (status, title, paid) => {
      await renderWithQuery(<App />);
      await screen.findByRole("header", { name: "Your job is booked" });
      await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);

      // The job moved while the customer was away; coming back asks for it again, once for the
      // notice and once for the card.
      const before = callsTo(apiGet, JOB_PATH).length;
      const answers: Promise<unknown>[] = [];
      api.job = () => {
        const answer = Promise.resolve({ ...JOB, status });
        answers.push(answer);
        return answer;
      };
      await act(async () => navigation.setFocused(false));
      await act(async () => navigation.setFocused(true));

      expect(await screen.findByRole("header", { name: title })).toBeTruthy();
      await waitFor(() => expect(callsTo(apiGet, JOB_PATH)).toHaveLength(before + 2));
      await act(async () => void (await Promise.all(answers)));
      await waitFor(() => expect(paidState()).toHaveLength(paid ? 1 : 0));
      expect(bookedTexts()).toHaveLength(0);
      expect(screen.queryByRole("button", { name: FOLLOW })).toBeNull();
      // Still one notice and one way to the job, now to look back at it.
      expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "See your job" })).toHaveLength(1);
      expect(cardButtons()).toEqual(["View María P.'s profile"]);
      expect(screen.queryByRole("button", { name: PAY_NAME })).toBeNull();
    },
  );
});

describe("the notifications pre-prompt sits under Paid, and says nothing about booking (#334)", () => {
  it("a paid request: one notice, Paid, and the pre-prompt under it, which asks nothing yet", async () => {
    await askable();
    await renderWithQuery(<App />);

    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
    const prompt = await screen.findByTestId(PROMPT);
    expect(within(prompt).getByText(PROMPT_BODY)).toBeTruthy();
    // On the accepted card, right under the badge.
    expect(
      card(ACCEPTED)
        .getAllByTestId(/-(paid|notifications)$/)
        .map((node) => node.props.testID),
    ).toEqual([`${payTestId(ACCEPTED)}-paid`, PROMPT]);
    // Still one booked line on the screen and one way to the job: the notice's.
    expect(bookedTexts()).toHaveLength(1);
    expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
    expect(screen.getAllByText("Paid")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: FOLLOW })).toHaveLength(1);
    expect(cardButtons()).toEqual(["View María P.'s profile", "Turn on", "Not now"]);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    // Not now: the card closes for good; Paid and the notice stay.
    await act(async () => fireEvent.press(within(prompt).getByRole("button", { name: "Not now" })));
    expect(screen.queryByTestId(PROMPT)).toBeNull();
    expect(paidState()).toHaveLength(1);
    expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
    expect(cardButtons()).toEqual(["View María P.'s profile"]);
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      DISMISSED_KEY,
      "1",
      expect.anything(),
    );
  });

  it("closed before on this device: Paid and the notice, no pre-prompt", async () => {
    await secureStoreMock.setItemAsync(DISMISSED_KEY, "1");
    await askable();
    await renderWithQuery(<App />);

    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    await waitFor(() => expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith(DISMISSED_KEY));
    await act(async () => {});
    expect(screen.queryByTestId(PROMPT)).toBeNull();
    expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
    expect(cardButtons()).toEqual(["View María P.'s profile"]);
  });

  it("not before the payment, nor while it is confirmed: it comes with Paid", async () => {
    fakeClock();
    await askable();
    api.job = () => Promise.reject(notFound());
    await renderWithQuery(<App />);

    await act(async () => fireEvent.press(await screen.findByRole("button", { name: PAY_NAME })));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-confirming`);
    expect(screen.queryByTestId(PROMPT)).toBeNull();
    expect(screen.queryByText(PROMPT_BODY)).toBeNull();

    api.job = () => Promise.resolve(JOB);
    await act(async () => jest.advanceTimersByTime(2_000));
    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    expect(await screen.findByTestId(PROMPT)).toBeTruthy();
    expect(bookedTexts()).toHaveLength(1);
  });

  it.each([
    ["cancelled", "This job was cancelled", false],
    ["refunded", "This job was cancelled", false],
    ["confirmed", "Job confirmed", true],
  ] as const)("once the job is %s, the pre-prompt goes with Paid", async (status, title, shown) => {
    await askable();
    await renderWithQuery(<App />);
    await screen.findByTestId(PROMPT);

    const answers: Promise<unknown>[] = [];
    api.job = () => {
      const answer = Promise.resolve({ ...JOB, status });
      answers.push(answer);
      return answer;
    };
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    expect(await screen.findByRole("header", { name: title })).toBeTruthy();
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => void (await Promise.all(answers)));

    await waitFor(() => expect(paidState()).toHaveLength(shown ? 1 : 0));
    expect(screen.queryAllByTestId(PROMPT)).toHaveLength(shown ? 1 : 0);
  });
});

/**
 * The notice's look and the card's answered apart: the notice's is pinned to the session (#64),
 * the card's is not while no payment is being confirmed.
 */
function answerApart(notice: () => Promise<CustomerJob>, cardLook: () => Promise<CustomerJob>) {
  jest.mocked(apiGet).mockImplementation(((path: string, options?: { generation?: number }) => {
    if (path !== JOB_PATH) return api.quotes();
    return options?.generation === undefined ? cardLook() : notice();
  }) as unknown as typeof apiGet);
}

const unavailable = () => Promise.reject(new ApiError(503, "unavailable"));

/** One booked notice with its one link, Paid on the card, and nothing said or felt. */
async function expectOneNotice() {
  expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();
  expect(bookedTexts()).toHaveLength(1);
  expect(screen.getAllByTestId("job-booked")).toHaveLength(1);
  expect(paidState()).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: FOLLOW })).toHaveLength(1);
  await act(async () => fireEvent.press(screen.getByRole("button", { name: FOLLOW })));
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith(JOB_HREF);
  // Not a payment confirmed in this session: no "you're booked" and no success haptic.
  expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
}

describe("a paid request opened cold: the card's job fills a notice that has none (#372)", () => {
  beforeEach(() => jest.mocked(Haptics.notificationAsync).mockClear());

  it.each([
    ["failed (503)", unavailable],
    ["came just before the webhook made the job (404)", () => Promise.reject(notFound())],
  ])("the notice's own look %s, the card's found the job: one notice", async (_, notice) => {
    answerApart(notice, () => Promise.resolve(JOB));
    await renderWithQuery(<App />);

    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    await expectOneNotice();
    // One look each; the card's answer is handed over, and nothing asks again.
    expect(callsTo(apiGet, JOB_PATH)).toHaveLength(2);
  });

  it("the notice's failure lands after the card's job: the notice keeps it", async () => {
    let failNotice: () => void = () => undefined;
    const notice = new Promise<CustomerJob>((_, reject) => {
      failNotice = () => reject(new ApiError(503, "unavailable"));
    });
    answerApart(
      () => notice,
      () => Promise.resolve(JOB),
    );
    await renderWithQuery(<App />);
    await screen.findByTestId(`${payTestId(ACCEPTED)}-paid`);
    expect(await screen.findByRole("header", { name: "Your job is booked" })).toBeTruthy();

    await act(async () => {
      failNotice();
      await notice.catch(() => undefined);
    });
    await expectOneNotice();
  });

  it("a look from a session that signed out never lands, in the next account or its notice", async () => {
    const client = newQueryClient();
    let answerCard: (job: CustomerJob) => void = () => undefined;
    const held = new Promise<CustomerJob>((resolve) => {
      answerCard = resolve;
    });
    answerApart(unavailable, () => held);
    await renderWithQuery(<App />, client);
    await waitFor(() => expect(callsTo(apiGet, JOB_PATH)).toHaveLength(2));

    // Signed out, then another account: the request is not theirs (404 to both looks).
    await signOut(session, client);
    answerApart(
      () => Promise.reject(notFound()),
      () => Promise.reject(notFound()),
    );
    await act(async () => {
      answerCard(JOB);
      await held;
    });
    await act(async () => navigation.setFocused(false));
    await act(async () => navigation.setFocused(true));
    await screen.findByRole("button", { name: PAY_NAME });

    expect(screen.queryByTestId("job-booked")).toBeNull();
    expect(bookedTexts()).toHaveLength(0);
    expect(paidState()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: FOLLOW })).toBeNull();
    expect(client.getQueryData(customerJobQueryKey(REQUEST_ID, 1))).toBeUndefined();
    expect(client.getQueryData(customerJobQueryKey(REQUEST_ID, 2))).toBeUndefined();
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });
});
