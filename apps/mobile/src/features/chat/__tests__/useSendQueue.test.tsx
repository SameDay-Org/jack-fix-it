import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { NetworkError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { NOW, newQueryClient } from "../../quotes/__tests__/helpers";
import { sendMessage } from "../api";
import type { ChatMessage } from "../thread";
import { useSendQueue, type SendQueue } from "../useSendQueue";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  onSignOut: jest.fn(() => () => undefined),
  apiConfig: { timeoutMs: 15_000 },
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSessionGeneration: jest.fn(() => 1),
  useSession: jest.fn(),
  setSessionUser: jest.fn(),
  logout: jest.fn(),
}));
jest.mock("../api", () => ({ sendMessage: jest.fn() }));

const JOB = "9a000000-0000-4000-8000-000000000074";
const send = jest.mocked(sendMessage);

const stored = (body: string): ChatMessage => ({
  id: "7c000000-0000-4000-8000-000000000999",
  sender: "me",
  body,
  redacted: false,
  created_at: new Date(NOW).toISOString(),
  receipt: null,
});

const sentBodies = () => send.mock.calls.map(([, , body, generation]) => [body, generation]);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

type Props = { generation: number };

async function renderQueue(initial: Props) {
  const client = newQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const listeners = { onClosed: jest.fn(), onDone: jest.fn() };
  const rendered = await renderHook(
    ({ generation }: Props) => useSendQueue(JOB, generation, listeners),
    { initialProps: initial, wrapper: Wrapper },
  );
  return { ...rendered, listeners };
}

/** The customer's message, failed offline under generation 1, and the retry the bubble held. */
async function failedUnderTheCustomer() {
  send.mockRejectedValueOnce(new NetworkError(false));
  const rendered = await renderQueue({ generation: 1 });
  await act(async () => rendered.result.current.send("Customer text that failed offline"));
  await flush();
  const [failed] = rendered.result.current.pending;
  expect(failed?.state).toBe("failed");
  const staleRetry: SendQueue["retry"] = rendered.result.current.retry;
  return { ...rendered, failed: failed!, staleRetry };
}

beforeEach(() => {
  send.mockReset();
});

describe("useSendQueue across a session change (#74 round 1)", () => {
  it("drops every bubble, text and all, the render the generation changes", async () => {
    const { result, rerender } = await failedUnderTheCustomer();

    await rerender({ generation: 2 });

    expect(result.current.pending).toEqual([]);
    expect(result.current.notice).toBeNull();
  });

  it("a retry held from before the change sends nothing", async () => {
    const { rerender, failed, staleRetry, listeners } = await failedUnderTheCustomer();
    await rerender({ generation: 2 });

    await act(async () => staleRetry(failed.localId));
    await flush();

    expect(sentBodies()).toEqual([["Customer text that failed offline", 1]]);
    expect(listeners.onDone).toHaveBeenCalledTimes(1); // the first failure only
  });

  it("a retry held from before the change never reorders the next account's sends", async () => {
    const { result, rerender, failed, staleRetry } = await failedUnderTheCustomer();
    await rerender({ generation: 2 });
    const first = deferred<ChatMessage>();
    send.mockReturnValueOnce(first.promise).mockResolvedValueOnce(stored("Second from the pro"));

    await act(async () => result.current.send("First from the pro"));
    await flush();
    await act(async () => staleRetry(failed.localId));
    await act(async () => result.current.send("Second from the pro"));
    await flush();
    // The second waits for the first, in the order typed.
    expect(sentBodies()).toEqual([
      ["Customer text that failed offline", 1],
      ["First from the pro", 2],
    ]);

    await act(async () => first.resolve(stored("First from the pro")));
    await flush();
    expect(sentBodies()).toEqual([
      ["Customer text that failed offline", 1],
      ["First from the pro", 2],
      ["Second from the pro", 2],
    ]);
  });

  it("the same generation keeps its bubbles across renders", async () => {
    const { result, rerender } = await failedUnderTheCustomer();

    await rerender({ generation: 1 });

    expect(result.current.pending.map(({ state }) => state)).toEqual(["failed"]);
  });
});
