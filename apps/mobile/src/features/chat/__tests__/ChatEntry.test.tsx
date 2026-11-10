import "@/i18n";

import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { router } from "expo-router";

import { apiGet } from "@/api";

import { navigation, quote, renderWithQuery, REQUEST_ID } from "../../quotes/__tests__/helpers";
import type { CustomerQuoteList } from "../../quotes/useRequestQuotes";
import { JobScreen } from "../../jobs/JobScreen";
import type { CustomerJob, JobStatus } from "../../jobs/phase";
import { ChatEntry } from "../ChatEntry";
import { isChatClosed } from "../peer";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(() => () => undefined),
  apiConfig: { timeoutMs: 15_000 },
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSessionGeneration: jest.fn(() => 1),
  setSessionUser: jest.fn(),
  useSession: jest.fn(() => ({ status: "signedIn", user: null })),
  logout: jest.fn(),
}));
jest.mock("expo-router", () => jest.requireActual("../../quotes/__tests__/helpers").routerMock);
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const JOB_ID = "9a000000-0000-4000-8000-000000000074";
const CHAT = "/jobs/[id]/chat";

const OPEN: readonly JobStatus[] = [
  "scheduled",
  "on_the_way",
  "in_progress",
  "completed",
  "disputed",
];
const CLOSED: readonly JobStatus[] = ["confirmed", "paid_out", "refunded", "cancelled"];

type EntryOverrides = {
  status?: JobStatus;
  unread?: number;
  requestId?: string;
};

const renderEntry = ({ status = "scheduled", unread = 0, requestId }: EntryOverrides = {}) =>
  render(
    <ChatEntry jobId={JOB_ID} requestId={requestId} name="Dan" status={status} unread={unread} />,
  );

const entry = () => screen.getByTestId("chat-entry");
const badgeText = () =>
  within(screen.getByTestId("chat-entry-badge"))
    .getAllByText(/./)
    .map((node) => [node.props.children as string | number].flat().join(""))
    .join("");

beforeEach(() => {
  jest.clearAllMocks();
  navigation.reset();
});

describe("isChatClosed", () => {
  it.each(OPEN)("%s: the chat is open", (status) => {
    expect(isChatClosed(status)).toBe(false);
  });

  it.each(CLOSED)("%s: the chat is read-only", (status) => {
    expect(isChatClosed(status)).toBe(true);
  });
});

describe("ChatEntry", () => {
  it.each(OPEN)("offers to message the other side while the job is %s", async (status) => {
    await renderEntry({ status });

    expect(screen.getByText("Message Dan")).toBeTruthy();
    expect(entry().props.accessibilityLabel).toBe("Message Dan");
    expect(entry().props.accessibilityRole).toBe("button");
  });

  it.each(CLOSED)("offers to view the messages once the job is %s", async (status) => {
    await renderEntry({ status });

    expect(screen.getByText("View messages")).toBeTruthy();
    expect(screen.queryByText("Message Dan")).toBeNull();
    expect(entry().props.accessibilityLabel).toBe("View messages");
  });

  it("with 2 unread, the badge shows 2 and the name says it in words", async () => {
    await renderEntry({ unread: 2 });

    expect(badgeText()).toBe("2");
    expect(entry().props.accessibilityLabel).toBe("Message Dan, 2 unread messages");
  });

  it("with 1 unread, the name says it in the singular", async () => {
    await renderEntry({ unread: 1 });

    expect(badgeText()).toBe("1");
    expect(entry().props.accessibilityLabel).toBe("Message Dan, 1 unread message");
  });

  it("a closed chat still counts what is unread", async () => {
    await renderEntry({ status: "confirmed", unread: 2 });

    expect(badgeText()).toBe("2");
    expect(entry().props.accessibilityLabel).toBe("View messages, 2 unread messages");
  });

  it("with nothing unread, no badge and the label alone", async () => {
    await renderEntry({ unread: 0 });

    expect(screen.queryByTestId("chat-entry-badge")).toBeNull();
    expect(entry().props.accessibilityLabel).toBe("Message Dan");
  });

  it("the customer's press opens the job's chat with the request it belongs to", async () => {
    await renderEntry({ requestId: REQUEST_ID });

    await act(async () => fireEvent.press(entry()));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: CHAT,
      params: { id: JOB_ID, request: REQUEST_ID },
    });
  });

  it("the pro's press opens the job's chat by the job alone", async () => {
    await renderEntry();

    await act(async () => fireEvent.press(entry()));

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({ pathname: CHAT, params: { id: JOB_ID } });
  });

  it("a second tap before the first push lands pushes nothing more", async () => {
    await renderEntry({ requestId: REQUEST_ID });

    await act(async () => fireEvent.press(entry()));
    await act(async () => fireEvent.press(entry()));

    expect(router.push).toHaveBeenCalledTimes(1);
  });
});

describe("the customer's job screen opens the chat (#74)", () => {
  const JOB_PATH = "/v1/requests/{request_id}/job";
  const QUOTES_PATH = "/v1/requests/{request_id}/quotes";
  const ACCEPTED = quote(2, { status: "accepted" });
  const QUOTE_LIST: CustomerQuoteList = { items: [quote(1), ACCEPTED] };
  const JOB: CustomerJob = {
    id: JOB_ID,
    status: "scheduled",
    customer_status: "customerStatus.scheduled",
    scheduled_start_at: "2026-10-29T16:00:00Z",
    pro: {
      id: "00000000-0000-4000-8000-000000000202",
      name: "Dan K.",
      rating_avg: "4.80",
      jobs_count: 12,
      years_of_experience: 8,
      verified: true,
    },
    eta_at: null,
    arrival_code: null,
    timeline: [{ type: "created", status: "scheduled", at: "2026-10-28T12:00:00Z" }],
    amount_cents: 18_000,
    tax_cents: 0,
    customer_total_cents: 18_000,
    photos: { before: [], after: [], pending: 0 },
    // The confirmation window (#66): not open on these jobs.
    confirm_by: null,
    unread_messages: 2,
  };

  beforeEach(() => {
    jest.mocked(apiGet).mockImplementation((async (path: string) => {
      if (path === JOB_PATH) return JOB;
      if (path === QUOTES_PATH) return QUOTE_LIST;
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as typeof apiGet);
  });

  it("under the pro, it reads Message Dan with the unread count and opens the job's chat", async () => {
    await renderWithQuery(<JobScreen />);

    const chat = await screen.findByTestId("chat-entry");
    expect(within(chat).getByText("Message Dan")).toBeTruthy();
    expect(chat.props.accessibilityLabel).toBe("Message Dan, 2 unread messages");
    expect(badgeText()).toBe("2");

    await act(async () => fireEvent.press(chat));

    expect(router.push).toHaveBeenCalledWith({
      pathname: CHAT,
      params: { id: JOB_ID, request: REQUEST_ID },
    });
  });
});
