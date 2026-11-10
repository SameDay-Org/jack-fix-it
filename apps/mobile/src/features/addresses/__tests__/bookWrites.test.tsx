import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiDelete, apiGet, apiPatch, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { savedAddress } from "../../request/__tests__/helpers";
import {
  SAVED_ADDRESSES_QUERY_KEY,
  useCreateAddress,
  useDeleteAddress,
  useMakeDefaultAddress,
  useSavedAddresses,
  useUpdateAddress,
  type SavedAddress,
} from "../api";

// The session the test is in; a sign-out or another sign-in moves it on.
let mockGeneration = 1;
jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn((generation: number) => generation === mockGeneration),
  sessionGeneration: jest.fn(() => mockGeneration),
}));
jest.mock("expo-haptics");

const HOME = savedAddress({ id: "home", label: "Home", is_default: true });
const WORK = savedAddress({ id: "work", label: "Work", is_default: false });
const MOM = savedAddress({ id: "mom", label: "Mom's place", is_default: false });

/** What GET /v1/addresses answers now. */
let server: SavedAddress[];
let announce: jest.SpyInstance;

beforeEach(() => {
  mockGeneration = 1;
  server = [HOME, WORK, MOM];
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation(async () => ({ items: server }));
  jest.mocked(apiDelete).mockReset();
  jest.mocked(apiPatch).mockReset();
  jest.mocked(apiPost).mockReset();
  toastStore.setState({ current: null });
  // React Native's statics are Jest mocks already: spying again keeps their calls, so clear them.
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  announce.mockClear();
});

afterEach(async () => {
  // A refetch the test did not wait for lands here, inside act; the toast's timer would outlive it.
  await act(() => settle());
  dismissToast();
  jest.restoreAllMocks();
});

/** A cache per test that sets no timers: a finished mutation is otherwise kept for minutes. */
const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });

/** The book as the screens read it, and the writes, over one cache. */
async function renderBook(client: QueryClient = newQueryClient()) {
  const view = await renderHook(
    () => ({
      book: useSavedAddresses(),
      remove: useDeleteAddress(),
      makeDefault: useMakeDefaultAddress(),
      create: useCreateAddress(),
      update: useUpdateAddress(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );
  await waitFor(() => expect(view.result.current.book.data).toBeDefined());
  return { ...view, client };
}

/** The cached book, its default starred. */
const cached = (client: QueryClient) =>
  client
    .getQueryData<{ items: SavedAddress[] }>(SAVED_ADDRESSES_QUERY_KEY)
    ?.items.map((address) => (address.is_default ? `${address.id}*` : address.id));

const toast = () => toastStore.getState().current;

describe("Delete", () => {
  it("takes the address out at once, for its session, and the refetch after confirms it", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(HOME));

    // The default went with it: the oldest other address is the default now, as on the server.
    expect(cached(client)).toEqual(["work*", "mom"]);
    expect(apiDelete).toHaveBeenCalledWith("/v1/addresses/{address_id}", {
      auth: true,
      generation: 1,
      params: { address_id: "home" },
    });
    server = [{ ...WORK, is_default: true }, MOM];
    await act(async () => answer.resolve(undefined));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(announce).toHaveBeenCalledWith("Home deleted");
    expect(cached(client)).toEqual(["work*", "mom"]);
    expect(toast()).toBeNull();
  });

  it("puts the address back and says so when the server refuses", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(WORK));
    expect(cached(client)).toEqual(["home*", "mom"]);
    await act(async () => answer.reject(new ApiError(500, "internal_error")));

    expect(cached(client)).toEqual(["home*", "work", "mom"]);
    expect(toast()).toMatchObject({
      message: "We couldn't delete Work. Try again in a moment.",
      tone: "danger",
    });
    expect(announce).not.toHaveBeenCalledWith("Work deleted");
  });

  it.each([
    [
      new NetworkError(false),
      "You're offline, so nothing changed. Try again once you're connected.",
    ],
    [new ApiError(429, "rate_limited"), "That's a lot of changes at once. Try again in a moment."],
  ])("words a %s failure for what it is", async (error, message) => {
    jest.mocked(apiDelete).mockRejectedValue(error);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(WORK));

    await waitFor(() => expect(toast()?.message).toBe(message));
    expect(cached(client)).toEqual(["home*", "work", "mom"]);
  });

  it("counts an address already gone (deleted on another device) as deleted", async () => {
    jest.mocked(apiDelete).mockRejectedValue(new ApiError(404, "address_not_found"));
    const { result, client } = await renderBook();
    server = [HOME, MOM];

    await act(async () => result.current.remove(WORK));

    await waitFor(() => expect(announce).toHaveBeenCalledWith("Work deleted"));
    expect(cached(client)).toEqual(["home*", "mom"]);
    expect(toast()).toBeNull();
  });
});

describe("Make default", () => {
  it("moves the address to the top with the chip at once, and sends is_default alone", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(MOM));

    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/addresses/{address_id}",
      { is_default: true },
      { auth: true, generation: 1, params: { address_id: "mom" } },
    );
    // The server lists the old default back in its place, oldest first.
    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];
    await act(async () => answer.resolve({ ...MOM, is_default: true }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(announce).toHaveBeenCalledWith("Mom's place is now your default");
  });

  it("puts the old default back when the server refuses", async () => {
    jest.mocked(apiPatch).mockRejectedValue(new ApiError(500, "internal_error"));
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(WORK));

    await waitFor(() =>
      expect(toast()?.message).toBe("We couldn't make Work your default. Try again in a moment."),
    );
    expect(cached(client)).toEqual(["home*", "work", "mom"]);
  });

  it("says when the address is no longer in the book", async () => {
    jest.mocked(apiPatch).mockRejectedValue(new ApiError(404, "address_not_found"));
    const { result } = await renderBook();
    server = [HOME, MOM];

    await act(async () => result.current.makeDefault(WORK));

    await waitFor(() =>
      expect(toast()?.message).toBe("That address isn't in your address book anymore."),
    );
  });
});

describe("two writes in flight", () => {
  it("a failure takes back only its own change: the newer write stays drawn", async () => {
    const deleted = deferred<undefined>();
    const madeDefault = deferred<SavedAddress>();
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    jest.mocked(apiPatch).mockReturnValue(madeDefault.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(WORK));
    await act(async () => result.current.makeDefault(MOM));
    expect(cached(client)).toEqual(["mom*", "home"]);

    await act(async () => deleted.reject(new ApiError(500, "internal_error")));
    expect(cached(client)).toEqual(["mom*", "work", "home"]);
    expect(toast()?.message).toBe("We couldn't delete Work. Try again in a moment.");
    // Only the last write answered refetches.
    expect(apiGet).toHaveBeenCalledTimes(1);

    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];
    await act(async () => madeDefault.resolve({ ...MOM, is_default: true }));

    await waitFor(() => expect(cached(client)).toEqual(["mom*", "home", "work"]));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("both failing offline leave the book as it was, though the refetch fails too", async () => {
    const deleted = deferred<undefined>();
    const madeDefault = deferred<SavedAddress>();
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    jest.mocked(apiPatch).mockReturnValue(madeDefault.promise);
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () => result.current.remove(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => deleted.reject(new NetworkError(false)));
    await act(async () => madeDefault.reject(new NetworkError(false)));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    // Every address is back and Home is the default again. The order of the others is the
    // server's to settle: the device has no creation dates.
    expect(cached(client)?.[0]).toBe("home*");
    expect([...(cached(client) ?? [])].sort()).toEqual(["home*", "mom", "work"]);
  });

  it("an earlier failure never undoes a later success", async () => {
    const deleted = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    jest.mocked(apiPatch).mockResolvedValue({ ...MOM, is_default: true });
    const { result, client } = await renderBook();

    // Deleting the default promotes Work; Mom is then made the default, and the server agrees.
    await act(async () => result.current.remove(HOME));
    await act(async () => result.current.makeDefault(MOM));
    expect(cached(client)).toEqual(["mom*", "work"]);
    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];
    await act(async () => deleted.reject(new ApiError(500, "internal_error")));

    // Home is back, under Mom's chip: not the default it was, since Mom took it since.
    expect(cached(client)?.slice(0, 2)).toEqual(["mom*", "home"]);
    await waitFor(() => expect(cached(client)).toEqual(["mom*", "home", "work"]));
  });
});

describe("a write belongs to the session it was asked in", () => {
  /** A sign-out, then another account: the cache is cleared and holds the new account's book. */
  const nextSession = (client: QueryClient, book: SavedAddress[]) => {
    mockGeneration = 2;
    server = book;
    client.clear();
    client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items: book });
  };
  /** The GETs sent for the session that asked (the first one, before the switch). */
  const firstSessionGets = () => jest.mocked(apiGet).mock.calls.length - getsAfterSwitch;
  let getsAfterSwitch = 0;
  const switchSession = async (client: QueryClient, book: SavedAddress[]) => {
    const before = jest.mocked(apiGet).mock.calls.length;
    await act(async () => nextSession(client, book));
    // The mounted book reads the new account's copy: let that settle inside act.
    await act(() => settle());
    getsAfterSwitch = jest.mocked(apiGet).mock.calls.length - before;
  };
  const CABIN = savedAddress({ id: "cabin", label: "Cabin", is_default: true });

  it("a failure after the session changed puts nothing back and shows nothing", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(WORK));
    await switchSession(client, [CABIN]);
    await act(async () => answer.reject(new ApiError(500, "internal_error")));

    expect(cached(client)).toEqual(["cabin*"]);
    expect(toast()).toBeNull();
    // No refetch on its behalf: only the first session's own GET.
    expect(firstSessionGets()).toBe(1);
  });

  it("an answer after the session changed draws nothing and says nothing", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(MOM));
    await switchSession(client, [CABIN]);
    await act(async () => answer.resolve({ ...MOM, is_default: true }));

    expect(cached(client)).toEqual(["cabin*"]);
    expect(announce).not.toHaveBeenCalled();
    expect(firstSessionGets()).toBe(1);
  });

  it("a new address saved after the session changed never joins the next account's book", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();
    const body = { line1: "1 Bay St", city: "Miami", state: "FL", zip_code: "33101" };

    let saving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saving = result.current.create.mutateAsync({
        body: { ...body, label: "Office", is_default: false },
        generation: 1,
      });
    });
    expect(apiPost).toHaveBeenCalledWith(
      "/v1/addresses",
      { ...body, label: "Office", is_default: false },
      { auth: true, generation: 1 },
    );
    await switchSession(client, [CABIN]);
    await act(async () => {
      answer.resolve(savedAddress({ id: "office", label: "Office", is_default: false }));
      await saving;
    });

    expect(cached(client)).toEqual(["cabin*"]);
  });
});

describe("Add and Edit", () => {
  it("a new address joins the book from the server's answer", async () => {
    const office = savedAddress({ id: "office", label: "Office", is_default: false });
    jest.mocked(apiPost).mockResolvedValue(office);
    const { result, client } = await renderBook();
    server = [HOME, WORK, MOM, office];

    await act(async () => {
      await result.current.create.mutateAsync({
        body: {
          line1: office.line1,
          city: office.city,
          state: office.state,
          zip_code: office.zip_code,
          label: "Office",
          is_default: false,
        },
        generation: 1,
      });
    });

    expect(cached(client)).toEqual(["home*", "work", "mom", "office"]);
  });

  it("an edited address takes the server's fields in its place", async () => {
    jest.mocked(apiPatch).mockResolvedValue({ ...WORK, label: "Office", line2: null });
    const { result, client } = await renderBook();
    server = [HOME, { ...WORK, label: "Office" }, MOM];

    await act(async () => {
      await result.current.update.mutateAsync({
        id: "work",
        body: { label: "Office", line2: null },
        generation: 1,
      });
    });

    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/addresses/{address_id}",
      { label: "Office", line2: null },
      { auth: true, generation: 1, params: { address_id: "work" } },
    );
    const items = client.getQueryData<{ items: SavedAddress[] }>(SAVED_ADDRESSES_QUERY_KEY)?.items;
    expect(items?.[1]).toMatchObject({ id: "work", label: "Office" });
  });
});
