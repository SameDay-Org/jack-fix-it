import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";

import { ApiError, apiPost, NetworkError, SessionExpiredError } from "@/api";

import { flattenOpportunities, OPPORTUNITIES_QUERY_KEY } from "../../pro-home/useOpportunities";
import type { QuoteCreate } from "../quoteDraft";
import { opportunityQueryKey } from "../useOpportunity";
import { sendFailureOf, useSendQuote, type SentQuote } from "../useSendQuote";
import { detail, DISPATCH_ID, newQueryClient, page, summary } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiPost: jest.fn(),
}));

const BODY: QuoteCreate = {
  amount_cents: 10_000,
  scope: "Paint the hallway.",
  duration_minutes: 60,
  proposed_start_at: "2026-10-30T13:00:00.000Z",
};

function seededClient(): QueryClient {
  const client = newQueryClient();
  client.setQueryData(OPPORTUNITIES_QUERY_KEY, {
    pages: [page([summary(1, { dispatch_id: DISPATCH_ID }), summary(2)])],
    pageParams: [undefined],
  });
  client.setQueryData(opportunityQueryKey(DISPATCH_ID), detail());
  return client;
}

const renderSend = (client: QueryClient) =>
  renderHook(() => useSendQuote(DISPATCH_ID), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });

const listed = (client: QueryClient) =>
  flattenOpportunities(client.getQueryData(OPPORTUNITIES_QUERY_KEY)).map((i) => i.dispatch_id);

beforeEach(() => jest.mocked(apiPost).mockReset());

describe("useSendQuote", () => {
  it("sends one POST however fast the calls come, and another once that one settled", async () => {
    let fail: (error: unknown) => void = () => undefined;
    jest.mocked(apiPost).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const onFailed = jest.fn();
    const { result } = await renderSend(seededClient());

    await act(async () => {
      result.current.send(BODY, { onSent: jest.fn(), onFailed });
      result.current.send(BODY, { onSent: jest.fn(), onFailed });
    });
    expect(apiPost).toHaveBeenCalledTimes(1);

    await act(async () => fail(new NetworkError(false)));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith("failed"));
    jest.mocked(apiPost).mockRejectedValueOnce(new NetworkError(true));
    await act(async () => result.current.send(BODY, { onSent: jest.fn(), onFailed }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
  });

  it("forgets the opportunity on a 201 even when the form closed before the answer", async () => {
    let answer: (quote: SentQuote) => void = () => undefined;
    jest.mocked(apiPost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve as (quote: SentQuote) => void;
        }),
    );
    const client = seededClient();
    const onSent = jest.fn();
    const { result, unmount } = await renderSend(client);

    await act(async () => result.current.send(BODY, { onSent, onFailed: jest.fn() }));
    await unmount();
    await act(async () => answer({} as SentQuote));

    await waitFor(() => expect(listed(client)).toEqual([summary(2).dispatch_id]));
    expect(client.getQueryData(opportunityQueryKey(DISPATCH_ID))).toBeUndefined();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("keeps the opportunity listed after a failure the pro can retry", async () => {
    jest.mocked(apiPost).mockRejectedValueOnce(new ApiError(422, "validation_error"));
    const client = seededClient();
    const onFailed = jest.fn();
    const { result } = await renderSend(client);

    await act(async () => result.current.send(BODY, { onSent: jest.fn(), onFailed }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith("invalid"));
    expect(listed(client)).toContain(DISPATCH_ID);
  });
});

describe("sendFailureOf", () => {
  it.each<[string, unknown, string]>([
    ["404", new ApiError(404, "not_found"), "gone"],
    ["409 not_quotable", new ApiError(409, "not_quotable"), "gone"],
    ["409 quote_exists", new ApiError(409, "quote_exists"), "alreadyQuoted"],
    ["422", new ApiError(422, "validation_error"), "invalid"],
    ["503", new ApiError(503, "not_configured"), "failed"],
    ["500", new ApiError(500, undefined), "failed"],
    ["a network error", new NetworkError(false), "failed"],
    ["a timeout", new NetworkError(true), "failed"],
    ["an ended session", new SessionExpiredError(), "signedOut"],
  ])("%s is %s", (_, error, failure) => {
    expect(sendFailureOf(error)).toBe(failure);
  });
});
