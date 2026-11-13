import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { createElement, type ReactNode } from "react";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiDelete, apiGet, apiPatch, apiPost, NetworkError } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";
import "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { savedAddress } from "../../request/__tests__/helpers";
import { resolveAddress } from "../../request/address";
import {
  SAVED_ADDRESSES_QUERY_KEY,
  useCreateAddress,
  useDeleteAddress,
  useMakeDefaultAddress,
  useSavedAddresses,
  useUpdateAddress,
  type SavedAddress,
  type SavedBook,
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

/** Whether the cached book is one whose other addresses the device cannot vouch for. */
const guessed = (client: QueryClient) =>
  client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.guessed ?? false;

/** Home once another address is the default. */
const HOME_OTHER = { ...HOME, is_default: false };

/** An address's label in the cached book. */
const labelOf = (client: QueryClient, id: string) =>
  client
    .getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)
    ?.items.find((address) => address.id === id)?.label;

const toast = () => toastStore.getState().current;

describe("Delete", () => {
  it("takes the address out at once, for its session, and the refetch after confirms it", async () => {
    const answer = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.remove(HOME));

    // The default went with it: the oldest other address is the default now, as on the server.
    expect(cached(client)).toEqual(["work*", "mom"]);
    expect(apiDelete).toHaveBeenCalledWith("/v1/addresses/{address_id}", undefined, {
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
    // Work is back in its place, under the write still in flight.
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
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
    // The book as the server last listed it, in its order: neither write happened.
    expect(cached(client)).toEqual(["home*", "work", "mom"]);
    expect(guessed(client)).toBe(false);
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

  it("the next session's writes never read the writes or the book of the one before", async () => {
    const old = deferred<undefined>();
    const next = deferred<SavedAddress>();
    jest.mocked(apiDelete).mockReturnValue(old.promise);
    jest.mocked(apiPatch).mockReturnValue(next.promise);
    const { result, client } = await renderBook();
    const LAKE = savedAddress({ id: "lake", label: "Lake", is_default: false });

    await act(async () => result.current.remove(WORK));
    await switchSession(client, [CABIN, LAKE]);
    // The first account's writes in flight went with its cached book, at the sign-out.
    expect(client.getQueryCache().hasListeners()).toBe(false);
    await act(async () => result.current.makeDefault(LAKE));
    expect(cached(client)).toEqual(["lake*", "cabin"]);
    // The first account's delete is refused: nothing of it is drawn, nor of its book.
    await act(async () => old.reject(new ApiError(500, "internal_error")));
    expect(cached(client)).toEqual(["lake*", "cabin"]);
    expect(toast()).toBeNull();
    await act(async () => next.reject(new ApiError(500, "internal_error")));

    expect(cached(client)).toEqual(["cabin*", "lake"]);
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

describe("overlapping writes, with no GET to repair them", () => {
  const offline = () => new NetworkError(false);
  /** From here on the book cannot be fetched again: what the device draws is all it has. */
  const getsFail = () => jest.mocked(apiGet).mockRejectedValue(offline());
  /** Two answers to PATCH, in the order the writes are asked. */
  const twoPatches = () => {
    const answers = [deferred<SavedAddress>(), deferred<SavedAddress>()] as const;
    jest
      .mocked(apiPatch)
      .mockReturnValueOnce(answers[0].promise)
      .mockReturnValueOnce(answers[1].promise);
    return answers;
  };

  // The Gatekeeper's three probes of round 1 (PR #354), as it wrote them.
  it("two failed default changes restore the original default in either failure order", async () => {
    const first = deferred<SavedAddress>();
    const second = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    expect(cached(client)?.[0]).toBe("mom*");
    await act(async () => first.reject(new NetworkError(false)));
    await act(async () => second.reject(new NetworkError(false)));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)?.[0]).toBe("home*");
  });

  it("two failed deletes restore the original default when the first fails first", async () => {
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    jest.mocked(apiDelete).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () => result.current.remove(HOME));
    await act(async () => result.current.remove(WORK));
    expect(cached(client)).toEqual(["mom*"]);
    await act(async () => first.reject(new NetworkError(false)));
    await act(async () => second.reject(new NetworkError(false)));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)?.[0]).toBe("home*");
    expect(cached(client)).toHaveLength(3);
  });

  it("an earlier default success preserves a later optimistic default while it is pending", async () => {
    const first = deferred<SavedAddress>();
    const second = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    expect(cached(client)?.[0]).toBe("mom*");
    await act(async () => first.resolve({ ...WORK, is_default: true }));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(cached(client)?.[0]).toBe("mom*");
  });

  // The same rule in the other orders, and to the address.
  it("two failed default changes leave the book as listed when the later one fails first", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    getsFail();

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => second.reject(offline()));
    // Mom's change is gone; Work's, still in flight, shows again.
    expect(cached(client)).toEqual(["work*", "home", "mom"]);
    await act(async () => first.reject(offline()));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["home*", "work", "mom"]);
    expect(guessed(client)).toBe(false);
  });

  it.each([
    ["the first fails first", [0, 1]],
    ["the later one fails first", [1, 0]],
  ])(
    "two failed deletes bring both addresses back in their place when %s",
    async (_name, order) => {
      const answers = [deferred<undefined>(), deferred<undefined>()];
      jest
        .mocked(apiDelete)
        .mockReturnValueOnce(answers[0].promise)
        .mockReturnValueOnce(answers[1].promise);
      const { result, client } = await renderBook();
      getsFail();

      await act(async () => result.current.remove(HOME));
      await act(async () => result.current.remove(WORK));
      for (const index of order) await act(async () => answers[index].reject(offline()));

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["home*", "work", "mom"]);
    },
  );

  it("a later success keeps its choice when the earlier change is answered after it", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    getsFail();

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => second.resolve({ ...MOM, is_default: true }));
    // Mom was asked last: Work's change, still in flight, is not drawn over her answer.
    expect(cached(client)).toEqual(["mom*", "work", "home"]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve({ ...WORK, is_default: true }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["mom*", "work", "home"]);
    // Both are the server's now, but where Home and Work fall is the device's guess.
    expect(guessed(client)).toBe(true);
  });

  it("a later success stays when the earlier change is refused after it", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    getsFail();

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => second.resolve({ ...MOM, is_default: true }));
    await act(async () => first.reject(offline()));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    // As if Work's change had never been asked.
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
  });

  it("an earlier success stays when the later change is refused", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    getsFail();

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => first.resolve({ ...WORK, is_default: true }));
    await act(async () => second.reject(offline()));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["work*", "home", "mom"]);
    expect(toast()?.message).toBe(
      "You're offline, so nothing changed. Try again once you're connected.",
    );
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "a delete the server confirmed stays out when a default change is refused %s it",
    async (_name, refusedFirst) => {
      const deleted = deferred<undefined>();
      const madeDefault = deferred<SavedAddress>();
      jest.mocked(apiDelete).mockReturnValue(deleted.promise);
      jest.mocked(apiPatch).mockReturnValue(madeDefault.promise);
      const { result, client } = await renderBook();
      getsFail();

      await act(async () => result.current.remove(WORK));
      await act(async () => result.current.makeDefault(MOM));
      const answers = [() => madeDefault.reject(offline()), () => deleted.resolve(undefined)];
      if (!refusedFirst) answers.reverse();
      for (const answer of answers) await act(async () => answer());

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["home*", "mom"]);
    },
  );

  it("two answers in the same tick fetch the book again, once", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];

    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => {
      first.resolve({ ...WORK, is_default: true });
      second.resolve({ ...MOM, is_default: true });
    });

    await waitFor(() => expect(guessed(client)).toBe(false));
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
  });

  it("an edit answered while a later default change is in flight leaves that choice drawn", async () => {
    const [edited] = twoPatches();
    const { result, client } = await renderBook();

    // The default address is renamed; before the server answers, Mom is made the default.
    let saving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saving = result.current.update.mutateAsync({
        id: "home",
        body: { label: "House" },
        generation: 1,
      });
    });
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => {
      // Its answer still has Home as the default: it was, when the server answered.
      edited.resolve({ ...HOME, label: "House" });
      await saving;
    });

    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(labelOf(client, "home")).toBe("House");
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("two edits of an address answered out of order keep the fields asked last", async () => {
    const [first, second] = twoPatches();
    const { result, client } = await renderBook();
    getsFail();

    const savings: Promise<unknown>[] = [];
    for (const label of ["Office", "Studio"]) {
      await act(async () => {
        savings.push(
          result.current.update.mutateAsync({ id: "work", body: { label }, generation: 1 }),
        );
      });
    }
    await act(async () => {
      second.resolve({ ...WORK, label: "Studio" });
      await savings[1];
    });
    await act(async () => {
      first.resolve({ ...WORK, label: "Office" });
      await savings[0];
    });

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(labelOf(client, "work")).toBe("Studio");
  });

  it("a refused edit changes nothing, under a default change still in flight", async () => {
    const [edited] = twoPatches();
    const { result, client } = await renderBook();

    let saving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saving = result.current.update
        .mutateAsync({ id: "work", body: { label: "Home" }, generation: 1 })
        .catch((error: unknown) => error);
    });
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => {
      edited.reject(new ApiError(409, "address_label_taken"));
      await saving;
      // The hooks hear of it on the next tick: inside act, like the answer.
      await settle();
    });

    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(labelOf(client, "work")).toBe("Work");
  });
});

describe("a GET that lands while a write is in flight", () => {
  // Another screen opened or the app came back: the book is fetched again before the answer.
  it("is drawn under the write, and is what a refusal goes back to", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(MOM));
    // Another device renamed Work meanwhile; the server has not seen Mom's change yet.
    server = [HOME, { ...WORK, label: "Office" }, MOM];
    await act(async () => {
      await result.current.book.refetch();
    });

    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(labelOf(client, "work")).toBe("Office");
    expect(guessed(client)).toBe(true);
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => answer.reject(new ApiError(500, "internal_error")));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    // The list that GET brought, not the older one the write was first drawn on.
    expect(cached(client)).toEqual(["home*", "work", "mom"]);
    expect(labelOf(client, "work")).toBe("Office");
    expect(guessed(client)).toBe(false);
  });

  it("asked before two writes and landing between their answers, takes neither back", async () => {
    const stale = deferred<{ items: SavedAddress[] }>();
    const madeDefault = deferred<SavedAddress>();
    const deleted = deferred<undefined>();
    jest.mocked(apiPatch).mockReturnValue(madeDefault.promise);
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    const { result, client } = await renderBook();

    // The book is being fetched again (its screen just opened) when both writes are asked.
    jest.mocked(apiGet).mockReturnValueOnce(stale.promise);
    let refetching: Promise<unknown> = Promise.resolve();
    await act(async () => {
      refetching = result.current.book.refetch();
    });
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => result.current.remove(WORK));
    await act(async () => madeDefault.resolve({ ...MOM, is_default: true }));
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    // That GET's list is from before both: Mom's change, answered, is still drawn over it.
    await act(async () => {
      stale.resolve({ items: [HOME, WORK, MOM] });
      await refetching;
    });
    expect(cached(client)).toEqual(["mom*", "home"]);

    await act(async () => deleted.reject(new NetworkError(false)));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(guessed(client)).toBe(true);
  });

  it("asked before a write and still in flight at its answer, never lands over it", async () => {
    const stale = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiPatch).mockResolvedValue({ ...MOM, is_default: true });
    const { result, client } = await renderBook();

    jest.mocked(apiGet).mockReturnValueOnce(stale.promise);
    await act(async () => {
      void result.current.book.refetch();
    });
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => result.current.makeDefault(MOM));
    // The GET asked after the answer replaced it, and failed.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    await act(async () => stale.resolve({ items: [HOME, WORK, MOM] }));

    expect(cached(client)).toEqual(["mom*", "home", "work"]);
  });

  it("asked after two answers, replaces them: a write asked meanwhile is drawn on its list", async () => {
    const [first, second] = [deferred<SavedAddress>(), deferred<SavedAddress>()];
    const deleted = deferred<undefined>();
    jest.mocked(apiPatch).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    const { result, client } = await renderBook();

    // Work, then Mom, made the default, both answered: the book is fetched again.
    const listedAgain = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiGet).mockReturnValue(listedAgain.promise);
    await act(async () => result.current.makeDefault(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => first.resolve({ ...WORK, is_default: true }));
    await act(async () => second.resolve({ ...MOM, is_default: true }));
    expect(apiGet).toHaveBeenCalledTimes(2);
    // Mom is deleted before that GET lands.
    await act(async () => result.current.remove({ ...MOM, is_default: true }));
    await act(async () =>
      listedAgain.resolve({ items: [{ ...MOM, is_default: true }, HOME_OTHER, WORK] }),
    );

    // The list has both answers and its own order: Home, the oldest, takes Mom's place.
    expect(cached(client)).toEqual(["home*", "work"]);
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => deleted.resolve(undefined));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["home*", "work"]);
    expect(guessed(client)).toBe(false);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });

  it("asked after an answer, is what a write asked meanwhile and refused goes back to", async () => {
    const madeDefault = deferred<SavedAddress>();
    const deleted = deferred<undefined>();
    jest.mocked(apiPatch).mockReturnValue(madeDefault.promise);
    jest.mocked(apiDelete).mockReturnValue(deleted.promise);
    const { result, client } = await renderBook();

    const listedAgain = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiGet).mockReturnValue(listedAgain.promise);
    await act(async () => result.current.makeDefault(MOM));
    await act(async () => madeDefault.resolve({ ...MOM, is_default: true }));
    await act(async () => result.current.remove(WORK));
    // Another device renamed Work meanwhile.
    await act(async () =>
      listedAgain.resolve({
        items: [{ ...MOM, is_default: true }, HOME_OTHER, { ...WORK, label: "Office" }],
      }),
    );
    expect(cached(client)).toEqual(["mom*", "home"]);
    // Still open: the delete is unanswered.
    expect(client.getQueryCache().hasListeners()).toBe(true);

    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => deleted.reject(new ApiError(500, "internal_error")));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(labelOf(client, "work")).toBe("Office");
    expect(guessed(client)).toBe(false);
  });

  it("is what the write's answer is drawn on", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    await act(async () => result.current.makeDefault(MOM));
    server = [HOME, { ...WORK, label: "Office" }, MOM];
    await act(async () => {
      await result.current.book.refetch();
    });
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => answer.resolve({ ...MOM, is_default: true }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(labelOf(client, "work")).toBe("Office");
  });
});

describe("the cached book says when the device cannot vouch for its other addresses", () => {
  it("from the first change in flight until the server lists the book again", async () => {
    // Created oldest to newest: Home, Work, Mom, with Mom the default.
    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();
    expect(guessed(client)).toBe(false);
    expect(client.getQueryCache().hasListeners()).toBe(false);

    await act(async () => result.current.makeDefault(WORK));
    // The device draws Mom next; the server will list Home first, the older one.
    expect(cached(client)).toEqual(["work*", "mom", "home"]);
    expect(guessed(client)).toBe(true);
    // The book's GETs are watched from the first write asked.
    expect(client.getQueryCache().hasListeners()).toBe(true);
    server = [{ ...WORK, is_default: true }, { ...HOME, is_default: false }, MOM];
    const listedAgain = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiGet).mockReturnValue(listedAgain.promise);
    await act(async () => answer.resolve({ ...WORK, is_default: true }));

    // Answered, and still the device's order: only the GET asked after the answer settles it.
    expect(cached(client)).toEqual(["work*", "mom", "home"]);
    expect(guessed(client)).toBe(true);
    expect(client.getQueryCache().hasListeners()).toBe(true);
    await act(async () => listedAgain.resolve({ items: server }));

    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(cached(client)).toEqual(["work*", "home", "mom"]);
    expect(guessed(client)).toBe(false);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });

  it("the list asked after the last answer stands alone: no write is replayed over it", async () => {
    jest.mocked(apiPatch).mockResolvedValue({ ...WORK, is_default: true });
    const { result, client } = await renderBook();
    // By the time the book is listed again, another device has made Mom the default.
    server = [{ ...MOM, is_default: true }, { ...HOME, is_default: false }, WORK];

    await act(async () => result.current.makeDefault(WORK));

    await waitFor(() => expect(cached(client)).toEqual(["mom*", "home", "work"]));
    expect(guessed(client)).toBe(false);
  });

  it("not for a change that leaves one other address: its place is known", async () => {
    server = [HOME, WORK];
    jest.mocked(apiPatch).mockResolvedValue({ ...WORK, is_default: true });
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () => result.current.makeDefault(WORK));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["work*", "home"]);
    expect(guessed(client)).toBe(false);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });

  it("with no screen reading the book, an answered change stays as drawn: no list comes", async () => {
    jest.mocked(apiPatch).mockResolvedValue({ ...MOM, is_default: true });
    const client = newQueryClient();
    client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items: [HOME, WORK, MOM] });
    const { result } = await renderHook(() => useMakeDefaultAddress(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    await act(async () => result.current(MOM));
    await act(() => settle());

    expect(apiGet).not.toHaveBeenCalled();
    expect(cached(client)).toEqual(["mom*", "home", "work"]);
    expect(guessed(client)).toBe(true);
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });

  it("not for a form's write: it moves no one", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(answer.promise);
    const { result, client } = await renderBook();

    let saving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saving = result.current.update.mutateAsync({
        id: "work",
        body: { label: "Office" },
        generation: 1,
      });
    });
    expect(guessed(client)).toBe(false);
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => {
      answer.resolve({ ...WORK, label: "Office" });
      await saving;
    });

    expect(labelOf(client, "work")).toBe("Office");
    expect(guessed(client)).toBe(false);
  });

  it("deleting the default of a book in the device's order draws no default until it is listed", async () => {
    // Created oldest to newest: Work, Mom, Home, with Home the default.
    const listedBook = [HOME, WORK, MOM];
    jest.mocked(apiPatch).mockResolvedValue({ ...MOM, is_default: true });
    jest.mocked(apiDelete).mockResolvedValue(undefined);
    const { result, client } = await renderBook();
    expect(cached(client)).toEqual(listedBook.map((a) => (a.is_default ? `${a.id}*` : a.id)));
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    // Mom is the default now, for the server too; the book could not be listed again.
    await act(async () => result.current.makeDefault(MOM));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["mom*", "home", "work"]);

    // Deleted, the server promotes the older of Home and Work: Work. The device cannot tell.
    await act(async () => result.current.remove({ ...MOM, is_default: true }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["home", "work"]);
    expect(guessed(client)).toBe(true);

    server = [
      { ...WORK, is_default: true },
      { ...HOME, is_default: false },
    ];
    jest.mocked(apiGet).mockImplementation(async () => ({ items: server }));
    await act(async () => {
      await result.current.book.refetch();
    });
    expect(cached(client)).toEqual(["work*", "home"]);
    expect(guessed(client)).toBe(false);
  });
});

describe("a write asked before the book was cached", () => {
  const office = savedAddress({ id: "office", label: "Office", is_default: false });

  /** Asks to add Office over a cache with no book yet. Returns how to land the server's answer. */
  async function addOffice(client: QueryClient) {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    const { result } = await renderHook(() => useCreateAddress(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });
    let saving: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saving = result.current.mutateAsync({
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
    return () =>
      act(async () => {
        answer.resolve(office);
        await saving;
        // The hook hears of it on the next tick: inside act, like the answer.
        await settle();
      });
  }

  it("joins the book that arrived since, once the server answers", async () => {
    const client = newQueryClient();
    const answered = await addOffice(client);
    client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items: [HOME, WORK, MOM] });

    await answered();

    expect(cached(client)).toEqual(["home*", "work", "mom", "office"]);
  });

  it("joins no book once its session is gone", async () => {
    const client = newQueryClient();
    const answered = await addOffice(client);
    // Another account signed in meanwhile, and its book is cached.
    mockGeneration = 2;
    client.setQueryData(SAVED_ADDRESSES_QUERY_KEY, { items: [HOME] });

    await answered();

    expect(cached(client)).toEqual(["home*"]);
  });

  it("answered with no book cached, has the book fetched", async () => {
    // The book could not load; its screen is still asking for it.
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    jest.mocked(apiPost).mockResolvedValue(office);
    const client = newQueryClient();
    const { result } = await renderHook(
      () => ({ book: useSavedAddresses(), create: useCreateAddress() }),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      },
    );
    await waitFor(() => expect(result.current.book.isError).toBe(true));
    server = [HOME, office];

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

    await waitFor(() => expect(cached(client)).toEqual(["home*", "office"]));
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

describe("an answer changes only what its request sent", () => {
  const ORDERS = ["edit", "default"] as const;
  const other = (write: (typeof ORDERS)[number]) => (write === "edit" ? "default" : "edit");
  const CHANGES = { label: "Office", line1: "250 Changed St" };
  /** Work as the server has it once it took both writes, in either order. */
  const OFFICE = { ...WORK, ...CHANGES, is_default: true };
  const items = (client: QueryClient) =>
    client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.items;

  // Work is edited and made the default, both in flight together. The server takes the two in
  // either order, so each answer is the address with or without the other write's change, and the
  // answers land in either order too. No list comes after: the answers are all the device has.
  it.each(
    ORDERS.flatMap((asked) =>
      ORDERS.flatMap((taken) => ORDERS.map((answered) => ({ asked, taken, answered }))),
    ),
  )(
    "an edit and a default change of one address both stay: $asked asked first, $taken taken first by the server, $answered answered first",
    async ({ asked, taken, answered }) => {
      const answers = { edit: deferred<SavedAddress>(), default: deferred<SavedAddress>() };
      jest
        .mocked(apiPatch)
        .mockReturnValueOnce(answers[asked].promise)
        .mockReturnValueOnce(answers[other(asked)].promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      const ask = {
        edit: () => result.current.update.mutate({ id: "work", body: CHANGES, generation: 1 }),
        default: () => result.current.makeDefault(WORK),
      };
      const land = {
        edit: () => answers.edit.resolve({ ...OFFICE, is_default: taken === "default" }),
        default: () =>
          answers.default.resolve(taken === "edit" ? OFFICE : { ...WORK, is_default: true }),
      };

      await act(async () => ask[asked]());
      await act(async () => ask[other(asked)]());
      await act(async () => land[answered]());
      await act(async () => land[other(answered)]());

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["work*", "home", "mom"]);
      expect(items(client)?.[0]).toEqual(OFFICE);
      // The request flow's Where step reads the same book: it goes to the address as edited.
      expect(resolveAddress(null, items(client))).toEqual({ kind: "saved", address: OFFICE });
    },
  );

  // Two edits of Work, each sending its own field. Whichever the server took first, the answer of
  // the other has both changes and its own has one: neither answer takes the other's field back.
  const FIELDS = ["name", "street"] as const;
  it.each(FIELDS.flatMap((taken) => FIELDS.map((answered) => ({ taken, answered }))))(
    "two edits of one address that sent different fields both stay: the $taken taken first by the server, the $answered answered first",
    async ({ taken, answered }) => {
      const answers = { name: deferred<SavedAddress>(), street: deferred<SavedAddress>() };
      jest
        .mocked(apiPatch)
        .mockReturnValueOnce(answers.name.promise)
        .mockReturnValueOnce(answers.street.promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      const both = { ...WORK, ...CHANGES };
      const land = {
        name: () => answers.name.resolve(taken === "name" ? { ...both, line1: WORK.line1 } : both),
        street: () =>
          answers.street.resolve(taken === "street" ? { ...both, label: WORK.label } : both),
      };

      await act(async () =>
        result.current.update.mutate({
          id: "work",
          body: { label: CHANGES.label },
          generation: 1,
        }),
      );
      await act(async () =>
        result.current.update.mutate({
          id: "work",
          body: { line1: CHANGES.line1 },
          generation: 1,
        }),
      );
      await act(async () => land[answered]());
      await act(async () => land[answered === "name" ? "street" : "name"]());

      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(items(client)).toEqual([HOME, both, MOM]);
    },
  );

  it("an edit that got no answer is drawn as not made, whatever a later answer shows of it", async () => {
    // The server took the edit, but its answer was lost; the default change's answer then has the
    // new name. The device was told the edit failed and draws no field a request of its own did
    // not set with an answer: the same copy, read before the edit, would be the older one. The
    // next list says what the server has.
    const edited = deferred<SavedAddress>();
    const madeDefault = deferred<SavedAddress>();
    jest
      .mocked(apiPatch)
      .mockReturnValueOnce(edited.promise)
      .mockReturnValueOnce(madeDefault.promise);
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () =>
      result.current.update.mutate({ id: "work", body: CHANGES, generation: 1 }),
    );
    await act(async () => result.current.makeDefault(WORK));
    await act(async () => edited.reject(new NetworkError(false)));
    await act(async () => madeDefault.resolve(OFFICE));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(items(client)?.[0]).toEqual({ ...WORK, is_default: true });
  });

  it("a new address the list already has stays as listed under its own answer", async () => {
    // The add's answer is still to come when a list that has the address lands: read after the
    // server added it, and after it was renamed elsewhere.
    const office = savedAddress({ id: "office", label: "Office", is_default: false });
    const renamed = { ...office, label: "Studio" };
    const added = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValue(added.promise);
    const { result, client } = await renderBook();
    await act(async () =>
      result.current.create.mutate({
        body: {
          line1: office.line1,
          city: office.city,
          state: office.state,
          zip_code: office.zip_code,
          label: office.label,
          is_default: false,
        },
        generation: 1,
      }),
    );
    server = [HOME, WORK, MOM, renamed];
    await act(async () => {
      await client.refetchQueries({ queryKey: SAVED_ADDRESSES_QUERY_KEY });
    });
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

    await act(async () => added.resolve(office));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(items(client)).toEqual([HOME, WORK, MOM, renamed]);
  });
});

// The Gatekeeper's probes of round 2 (PR #354), as it wrote them but for the types (no address
// picked is null; an added address says it is not the default). The first one failed while a
// default change's answer was replayed whole.
describe("Gatekeeper r2: new interleavings", () => {
  const CABIN = savedAddress({ id: "cabin", label: "Cabin", is_default: false });
  const EDITED = { ...HOME, line1: "250 Changed St" };
  const CREATE_BODY = {
    label: CABIN.label,
    line1: CABIN.line1,
    city: CABIN.city,
    state: CABIN.state,
    zip_code: CABIN.zip_code,
    is_default: false,
  };

  const permutations = <T,>(items: T[]): T[][] =>
    items.length === 0
      ? [[]]
      : items.flatMap((item, index) =>
          permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
        );

  it.each([true, false])(
    "a default-only response cannot erase an overlapping edit, default response delivered first=%s",
    async (defaultFirst) => {
      const edit = deferred<SavedAddress>();
      const def = deferred<SavedAddress>();
      jest.mocked(apiPatch).mockReturnValueOnce(edit.promise).mockReturnValueOnce(def.promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      await act(async () => {
        result.current.update.mutate({
          id: "work",
          body: { label: "Office", line1: "250 Changed St" },
          generation: 1,
        });
      });
      await act(async () => result.current.makeDefault(WORK));
      // The server processes the later default-only request first, then commits the edit.
      // Those two responses can be delivered in either order.
      const answers = [
        () => def.resolve({ ...WORK, is_default: true }),
        () => edit.resolve({ ...WORK, label: "Office", line1: "250 Changed St", is_default: true }),
      ];
      if (!defaultFirst) answers.reverse();
      for (const answer of answers) await act(async () => answer());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["work*", "home", "mom"]);
      expect(
        resolveAddress(null, client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.items),
      ).toMatchObject({
        kind: "saved",
        address: { id: "work", label: "Office", line1: "250 Changed St" },
      });
      expect(client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.items[0]).toMatchObject({
        id: "work",
        label: "Office",
        line1: "250 Changed St",
        is_default: true,
      });
    },
  );

  it.each(permutations([0, 1, 2, 3]).map((order) => [order.join(""), order] as const))(
    "add/edit/delete/default survive response order %s with a failed repair GET",
    async (_name, order) => {
      const add = deferred<SavedAddress>();
      const edit = deferred<SavedAddress>();
      const del = deferred<undefined>();
      const def = deferred<SavedAddress>();
      jest.mocked(apiPost).mockReturnValue(add.promise);
      jest.mocked(apiPatch).mockReturnValueOnce(edit.promise).mockReturnValueOnce(def.promise);
      jest.mocked(apiDelete).mockReturnValue(del.promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      await act(async () => {
        result.current.create.mutate({ body: CREATE_BODY, generation: 1 });
      });
      await act(async () => {
        result.current.update.mutate({
          id: "home",
          body: { line1: EDITED.line1 },
          generation: 1,
        });
      });
      await act(async () => result.current.remove(WORK));
      await act(async () => result.current.makeDefault(MOM));
      const answers = [
        () => add.resolve(CABIN),
        () => edit.resolve(EDITED),
        () => del.resolve(undefined),
        () => def.reject(new NetworkError(false)),
      ];
      for (const index of order) await act(async () => answers[index]());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["home*", "mom", "cabin"]);
      const items = client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.items ?? [];
      expect(items.find((item) => item.id === "home")?.line1).toBe(EDITED.line1);
      expect(resolveAddress(null, items)).toMatchObject({
        kind: "saved",
        address: { id: "home", line1: EDITED.line1 },
      });
      expect(resolveAddress({ kind: "saved", id: "cabin" }, items)).toMatchObject({
        kind: "saved",
        address: { id: "cabin" },
      });
      expect(resolveAddress({ kind: "saved", id: "work" }, items)).toEqual({ kind: "typed" });
    },
  );

  it.each([true, false])(
    "edit of a deleted row never resurrects it, edit answers first=%s",
    async (first) => {
      const edit = deferred<SavedAddress>();
      const del = deferred<undefined>();
      jest.mocked(apiPatch).mockReturnValue(edit.promise);
      jest.mocked(apiDelete).mockReturnValue(del.promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      await act(async () => {
        result.current.update.mutate({
          id: "home",
          body: { line1: EDITED.line1 },
          generation: 1,
        });
      });
      await act(async () => result.current.remove(HOME));
      const answers = [() => edit.resolve(EDITED), () => del.resolve(undefined)];
      if (!first) answers.reverse();
      for (const answer of answers) await act(async () => answer());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["work*", "mom"]);
    },
  );

  it("four pending writes cannot affect a replacement session, including its own pending default", async () => {
    const add = deferred<SavedAddress>();
    const edit = deferred<SavedAddress>();
    const del = deferred<undefined>();
    const def = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValue(add.promise);
    jest.mocked(apiPatch).mockReturnValueOnce(edit.promise).mockReturnValueOnce(def.promise);
    jest.mocked(apiDelete).mockReturnValue(del.promise);
    const { result, client, unmount } = await renderBook();
    await act(async () => {
      result.current.create.mutate({ body: CREATE_BODY, generation: 1 });
    });
    await act(async () => {
      result.current.update.mutate({ id: "home", body: { line1: EDITED.line1 }, generation: 1 });
    });
    await act(async () => result.current.remove(WORK));
    await act(async () => result.current.makeDefault(MOM));
    await unmount();
    mockGeneration = 2;
    client.clear();
    const other = savedAddress({ id: "other", label: "Other", is_default: true });
    const second = savedAddress({ id: "second", label: "Second", is_default: false });
    server = [other, second];
    const next = await renderBook(client);
    const pending = deferred<SavedAddress>();
    jest.mocked(apiPatch).mockReturnValue(pending.promise);
    await act(async () => next.result.current.makeDefault(second));
    const gets = jest.mocked(apiGet).mock.calls.length;
    announce.mockClear();
    await act(async () => {
      add.resolve(CABIN);
      edit.resolve(EDITED);
      del.reject(new NetworkError(false));
      def.resolve({ ...MOM, is_default: true });
    });
    expect(cached(client)).toEqual(["second*", "other"]);
    expect(apiGet).toHaveBeenCalledTimes(gets);
    expect(announce).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    await act(async () => pending.reject(new NetworkError(false)));
    expect(cached(client)).toEqual(["other*", "second"]);
  });

  it("offline paused default and delete resume and roll back with a failing repair read", async () => {
    const { result, client } = await renderBook();
    jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
    jest.mocked(apiPatch).mockRejectedValue(new NetworkError(false));
    jest.mocked(apiDelete).mockRejectedValue(new NetworkError(false));
    onlineManager.setOnline(false);
    try {
      await act(async () => result.current.makeDefault(MOM));
      await act(async () => result.current.remove(WORK));
      expect(cached(client)).toEqual(["mom*", "home"]);
      expect(apiPatch).not.toHaveBeenCalled();
      expect(apiDelete).not.toHaveBeenCalled();
      await act(async () => {
        onlineManager.setOnline(true);
        await client.resumePausedMutations();
      });
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["home*", "work", "mom"]);
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe("two Adds in flight together", () => {
  const OFFICE = savedAddress({ id: "office", label: "Office", is_default: false });
  const LAKE = savedAddress({ id: "lake", label: "Lake", is_default: false });
  const bodyOf = (address: SavedAddress) => ({
    line1: address.line1,
    city: address.city,
    state: address.state,
    zip_code: address.zip_code,
    label: address.label,
    is_default: false,
  });
  /** A book of one address, and the answers to the two Adds, in the order they are asked. */
  const bookOfOne = async () => {
    server = [HOME];
    const answers = { office: deferred<SavedAddress>(), lake: deferred<SavedAddress>() };
    jest
      .mocked(apiPost)
      .mockReturnValueOnce(answers.office.promise)
      .mockReturnValueOnce(answers.lake.promise);
    return { ...(await renderBook()), answers };
  };
  const getsFail = () => jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

  // The server takes the two in either order and neither answer says which: Office and Lake are
  // drawn as asked, but which of them is the older one, the next default, the device cannot tell.
  it.each(["office", "lake"] as const)(
    "are drawn in a book the device does not vouch for: deleting the default crowns no one (%s answered first)",
    async (first) => {
      const { result, client, answers } = await bookOfOne();
      getsFail();
      jest.mocked(apiDelete).mockResolvedValue(undefined);

      await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
      await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
      const land = {
        office: () => answers.office.resolve(OFFICE),
        lake: () => answers.lake.resolve(LAKE),
      };
      await act(async () => land[first]());
      await act(async () => land[first === "office" ? "lake" : "office"]());

      // No list came after the answers: the book stays as drawn, and says it is a guess.
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["home*", "office", "lake"]);
      expect(guessed(client)).toBe(true);

      await act(async () => result.current.remove(HOME));
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
      expect(cached(client)).toEqual(["office", "lake"]);
      expect(guessed(client)).toBe(true);
    },
  );

  it("are placed by the list that comes after: the book is vouched for again", async () => {
    const { result, client, answers } = await bookOfOne();
    jest.mocked(apiDelete).mockResolvedValue(undefined);

    await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
    await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
    // The server took Lake first.
    server = [HOME, LAKE, OFFICE];
    await act(async () => answers.office.resolve(OFFICE));
    await act(async () => answers.lake.resolve(LAKE));

    await waitFor(() => expect(cached(client)).toEqual(["home*", "lake", "office"]));
    expect(guessed(client)).toBe(false);

    getsFail();
    await act(async () => result.current.remove(HOME));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["lake*", "office"]);
  });

  it("an Add asked once the other was answered knows its place, the newest", async () => {
    const { result, client, answers } = await bookOfOne();
    jest.mocked(apiDelete).mockResolvedValue(undefined);
    // The list asked after the first answer is still on its way when the second Add is asked.
    const listing = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiGet).mockReturnValueOnce(listing.promise);

    await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
    await act(async () => answers.office.resolve(OFFICE));
    getsFail();
    await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
    await act(async () => answers.lake.resolve(LAKE));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["home*", "office", "lake"]);
    expect(guessed(client)).toBe(false);

    await act(async () => result.current.remove(HOME));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(4));
    expect(cached(client)).toEqual(["office*", "lake"]);
  });

  it("deleting the default before any list comes crowns no one either", async () => {
    const { result, client, answers } = await bookOfOne();
    // The list asked after the two answers is still on its way, and so is the delete's answer.
    const listing = deferred<{ items: SavedAddress[] }>();
    jest.mocked(apiGet).mockReturnValue(listing.promise);
    jest.mocked(apiDelete).mockReturnValue(deferred<undefined>().promise);

    await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
    await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
    await act(async () => answers.office.resolve(OFFICE));
    await act(async () => answers.lake.resolve(LAKE));
    expect(cached(client)).toEqual(["home*", "office", "lake"]);

    await act(async () => result.current.remove(HOME));
    expect(cached(client)).toEqual(["office", "lake"]);
    await act(async () => listing.reject(new NetworkError(false)));
  });

  // The Add form opened by a link can be saved before the book loads: that Add has no place in a
  // book on screen, and is in flight with the next one all the same.
  it.each(["office", "lake"] as const)(
    "an Add asked before the book was cached counts too (%s answered first)",
    async (first) => {
      server = [HOME];
      jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
      const answers = { office: deferred<SavedAddress>(), lake: deferred<SavedAddress>() };
      jest
        .mocked(apiPost)
        .mockReturnValueOnce(answers.office.promise)
        .mockReturnValueOnce(answers.lake.promise);
      jest.mocked(apiDelete).mockResolvedValue(undefined);
      const client = newQueryClient();
      const { result } = await renderHook(
        () => ({
          book: useSavedAddresses(),
          create: useCreateAddress(),
          remove: useDeleteAddress(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) =>
            createElement(QueryClientProvider, { client }, children),
        },
      );
      await waitFor(() => expect(result.current.book.isError).toBe(true));

      await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
      // The book loads, read before the server took Office, and Lake is saved over it.
      await act(async () => {
        await result.current.book.refetch();
      });
      expect(cached(client)).toEqual(["home*"]);
      await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
      getsFail();
      const land = {
        office: () => answers.office.resolve(OFFICE),
        lake: () => answers.lake.resolve(LAKE),
      };
      await act(async () => land[first]());
      await act(async () => land[first === "office" ? "lake" : "office"]());

      await waitFor(() => expect(cached(client)).toEqual(["home*", "lake", "office"]));
      await act(() => settle());
      expect(guessed(client)).toBe(true);

      await act(async () => result.current.remove(HOME));
      await act(() => settle());
      expect(cached(client)).toEqual(["lake", "office"]);
    },
  );

  it("an Add of the session before, still unanswered, is not in flight with this session's", async () => {
    const { result, client, answers, unmount } = await bookOfOne();
    await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
    await unmount();
    // Another account signs in, and adds an address of its own.
    mockGeneration = 2;
    client.clear();
    server = [savedAddress({ id: "theirs", label: "Theirs", is_default: true })];
    const next = await renderBook(client);
    getsFail();

    await act(async () => next.result.current.create.mutate({ body: bodyOf(LAKE), generation: 2 }));
    await act(async () => answers.lake.resolve(LAKE));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(cached(client)).toEqual(["theirs*", "lake"]);
    expect(guessed(client)).toBe(false);
    // The first account's answer comes at last: it joins nothing.
    await act(async () => answers.office.resolve(OFFICE));
    expect(cached(client)).toEqual(["theirs*", "lake"]);
  });

  it("while one is unanswered, the other is not made the default as the only address drawn", async () => {
    const { result, client, answers } = await bookOfOne();
    getsFail();
    jest.mocked(apiDelete).mockResolvedValue(undefined);

    await act(async () => result.current.create.mutate({ body: bodyOf(OFFICE), generation: 1 }));
    await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
    await act(async () => answers.lake.resolve(LAKE));
    expect(cached(client)).toEqual(["home*", "lake"]);
    expect(guessed(client)).toBe(true);

    // The server may already have Office, the older one then: Lake is drawn without the chip.
    await act(async () => result.current.remove(HOME));
    expect(cached(client)).toEqual(["lake"]);

    await act(async () => answers.office.resolve(OFFICE));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(cached(client)).toEqual(["office", "lake"]);
    expect(guessed(client)).toBe(true);
  });
});

// The Gatekeeper's probes of round 3 (PR #354), as it wrote them but for the layout. The second
// one failed on both rows: the log closed with an Add asked before the book was cached still
// unanswered, and the next one no longer knew the book could be missing that address.
describe("Gatekeeper r3: five writes and a cold Add", () => {
  const CABIN = savedAddress({ id: "cabin", label: "Cabin", is_default: false });
  const LAKE = savedAddress({ id: "lake", label: "Lake", is_default: false });
  const bodyOf = (a: SavedAddress) => ({
    label: a.label,
    line1: a.line1,
    city: a.city,
    state: a.state,
    zip_code: a.zip_code,
    is_default: false,
  });
  const itemsOf = (client: QueryClient) =>
    client.getQueryData<SavedBook>(SAVED_ADDRESSES_QUERY_KEY)?.items;
  const permutations = <T,>(items: T[]): T[][] =>
    items.length === 0
      ? [[]]
      : items.flatMap((item, i) =>
          permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]),
        );

  it.each(permutations([0, 1, 2, 3, 4]).map((order) => [order.join(""), order] as const))(
    "add/add/edit/default/delete, response order %s, repair GET fails",
    async (_name, order) => {
      server = [HOME, WORK];
      const first = deferred<SavedAddress>(),
        second = deferred<SavedAddress>();
      const edit = deferred<SavedAddress>(),
        def = deferred<SavedAddress>(),
        del = deferred<undefined>();
      jest.mocked(apiPost).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      jest.mocked(apiPatch).mockReturnValueOnce(edit.promise).mockReturnValueOnce(def.promise);
      jest.mocked(apiDelete).mockReturnValue(del.promise);
      const { result, client } = await renderBook();
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      await act(async () => result.current.create.mutate({ body: bodyOf(CABIN), generation: 1 }));
      await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
      await act(async () =>
        result.current.update.mutate({
          id: WORK.id,
          body: { line1: "900 New St" },
          generation: 1,
        }),
      );
      await act(async () => result.current.makeDefault(WORK));
      await act(async () => result.current.remove(HOME));
      const answers = [
        () => first.resolve(CABIN),
        () => second.resolve(LAKE),
        () => edit.resolve({ ...WORK, line1: "900 New St" }),
        () => def.resolve({ ...WORK, is_default: true }),
        () => del.resolve(undefined),
      ];
      for (const i of order) await act(async () => answers[i]());
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
      expect(cached(client)).toEqual(["work*", "cabin", "lake"]);
      expect(guessed(client)).toBe(true);
      expect(resolveAddress(null, itemsOf(client))).toMatchObject({
        kind: "saved",
        address: { id: WORK.id, line1: "900 New St" },
      });
      jest.mocked(apiDelete).mockResolvedValue(undefined);
      await act(async () => result.current.remove({ ...WORK, is_default: true }));
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
      expect(cached(client)).toEqual(["cabin", "lake"]);
      expect(guessed(client)).toBe(true);
    },
  );

  it.each([true, false])(
    "a pre-cache Add still pending prevents a sole survivor being crowned after failed repair (delete answers=%s)",
    async (deleteAnswers) => {
      server = [HOME];
      const first = deferred<SavedAddress>(),
        second = deferred<SavedAddress>();
      const del = deferred<undefined>();
      jest.mocked(apiPost).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      jest.mocked(apiDelete).mockReturnValue(del.promise);
      const client = newQueryClient();
      jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
      const { result } = await renderHook(
        () => ({
          book: useSavedAddresses(),
          create: useCreateAddress(),
          remove: useDeleteAddress(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) =>
            createElement(QueryClientProvider, { client }, children),
        },
      );
      await waitFor(() => expect(result.current.book.isError).toBe(true));
      await act(async () => result.current.create.mutate({ body: bodyOf(CABIN), generation: 1 }));
      await act(async () => {
        await result.current.book.refetch();
      });
      await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      // Server has [Home*, Cabin, Lake], but the first Add's answer is still travelling.
      await act(async () => second.resolve(LAKE));
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
      await act(() => settle());
      expect(cached(client)).toEqual(["home*", "lake"]);
      expect(guessed(client)).toBe(true);
      await act(async () => result.current.remove(HOME));
      if (deleteAnswers) await act(async () => del.resolve(undefined));
      // Capture both the intermediate and settled state; no write answer is lost in this case.
      const afterDelete = { items: cached(client), guessed: guessed(client) };
      await act(async () => first.resolve(CABIN));
      if (!deleteAnswers) await act(async () => del.resolve(undefined));
      await act(() => settle());
      const afterAllAnswers = {
        items: cached(client),
        defaultIds: itemsOf(client)
          ?.filter((a) => a.is_default)
          .map((a) => a.id),
        guessed: guessed(client),
      };
      // The server promotes Cabin. Lake must not be guessed as default merely because Cabin was
      // not drawn yet.
      expect({ afterDelete, afterAllAnswers }).toMatchObject({
        afterDelete: { items: ["lake"], guessed: true },
        afterAllAnswers: { defaultIds: [], guessed: true },
      });
    },
  );

  it.each([true, false])(
    "five old writes settling after sign-out leave a replacement Add untouched, reverse=%s",
    async (reverse) => {
      const adds = [deferred<SavedAddress>(), deferred<SavedAddress>()];
      const edit = deferred<SavedAddress>(),
        def = deferred<SavedAddress>(),
        del = deferred<undefined>();
      jest
        .mocked(apiPost)
        .mockReturnValueOnce(adds[0].promise)
        .mockReturnValueOnce(adds[1].promise);
      jest.mocked(apiPatch).mockReturnValueOnce(edit.promise).mockReturnValueOnce(def.promise);
      jest.mocked(apiDelete).mockReturnValue(del.promise);
      const { result, client, unmount } = await renderBook();
      await act(async () => result.current.create.mutate({ body: bodyOf(CABIN), generation: 1 }));
      await act(async () => result.current.create.mutate({ body: bodyOf(LAKE), generation: 1 }));
      await act(async () =>
        result.current.update.mutate({ id: WORK.id, body: { label: "Office" }, generation: 1 }),
      );
      await act(async () => result.current.makeDefault(WORK));
      await act(async () => result.current.remove(HOME));
      await unmount();
      mockGeneration = 2;
      client.clear();
      server = [savedAddress({ id: "other", label: "Other", is_default: true })];
      const next = await renderBook(client);
      const own = deferred<SavedAddress>();
      jest.mocked(apiPost).mockReturnValue(own.promise);
      jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));
      await act(async () =>
        next.result.current.create.mutate({ body: bodyOf(MOM), generation: 2 }),
      );
      const gets = jest.mocked(apiGet).mock.calls.length;
      announce.mockClear();
      const answers = [
        () => adds[0].resolve(CABIN),
        () => adds[1].reject(new NetworkError(false)),
        () => edit.resolve({ ...WORK, label: "Office" }),
        () => def.resolve({ ...WORK, is_default: true }),
        () => del.reject(new NetworkError(false)),
      ];
      if (reverse) answers.reverse();
      for (const answer of answers) await act(async () => answer());
      expect(cached(client)).toEqual(["other*"]);
      expect(apiGet).toHaveBeenCalledTimes(gets);
      expect(announce).not.toHaveBeenCalled();
      expect(toast()).toBeNull();
      await act(async () => own.resolve(MOM));
      await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(gets + 1));
      expect(cached(client)).toEqual(["other*", "mom"]);
      expect(guessed(client)).toBe(false);
    },
  );
});

// An Add asked before the book was cached has no place in the log. The log can then close (its
// last write answered, and no list after it) while that Add is unanswered: the server may have
// its address, older than one the device draws, and the next log has to know it.
describe("an Add asked before the book was cached, unanswered when the log closes", () => {
  const CABIN = savedAddress({ id: "cabin", label: "Cabin", is_default: false });
  const LAKE = savedAddress({ id: "lake", label: "Lake", is_default: false });
  const bodyOf = (address: SavedAddress) => ({
    line1: address.line1,
    city: address.city,
    state: address.state,
    zip_code: address.zip_code,
    label: address.label,
    is_default: false,
  });
  const getsFail = () => jest.mocked(apiGet).mockRejectedValue(new NetworkError(false));

  /**
   * The book cannot load, and Cabin, then Lake if `both`, is asked. The book loads as `listed`,
   * read before the server took either. Lake is asked if it was not, and answered; the list asked
   * after its answer does not come. So Lake is drawn, Cabin is unanswered (`cabin` answers it),
   * and no write is left in the log. The server took Cabin first: neither answer says so.
   */
  async function lakeDrawnCabinUnanswered({ listed = [HOME], both = false } = {}) {
    server = listed;
    const cabin = deferred<SavedAddress>();
    const lake = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValueOnce(cabin.promise).mockReturnValueOnce(lake.promise);
    jest.mocked(apiGet).mockRejectedValueOnce(new NetworkError(false));
    jest.mocked(apiDelete).mockResolvedValue(undefined);
    const client = newQueryClient();
    const { result } = await renderHook(
      () => ({ book: useSavedAddresses(), create: useCreateAddress(), remove: useDeleteAddress() }),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      },
    );
    await waitFor(() => expect(result.current.book.isError).toBe(true));
    const add = (address: SavedAddress) =>
      act(async () => result.current.create.mutate({ body: bodyOf(address), generation: 1 }));

    await add(CABIN);
    if (both) await add(LAKE);
    await act(async () => {
      await result.current.book.refetch();
    });
    if (!both) await add(LAKE);
    getsFail();
    await act(async () => lake.resolve(LAKE));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    await act(() => settle());
    expect(cached(client)).toEqual([...cached(client)!.slice(0, listed.length), "lake"]);
    expect(guessed(client)).toBe(true);
    return { result, client, cabin };
  }

  /** Deletes `address`, and waits for the list asked after the server's answer to fail. */
  async function remove(
    result: Awaited<ReturnType<typeof lakeDrawnCabinUnanswered>>["result"],
    address: SavedAddress,
  ) {
    const gets = jest.mocked(apiGet).mock.calls.length;
    await act(async () => result.current.remove(address));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(gets + 1));
    await act(() => settle());
  }

  it.each(["before", "after"] as const)(
    "no address is crowned while it is: neither the next of two, nor the last one drawn (answered %s the last delete's answer)",
    async (cabinAnswers) => {
      const { result, client, cabin } = await lakeDrawnCabinUnanswered({ listed: [HOME, WORK] });

      // The server makes Work the default, then Cabin: the device draws neither as one.
      await remove(result, HOME);
      expect(cached(client)).toEqual(["work", "lake"]);
      const answer = deferred<undefined>();
      jest.mocked(apiDelete).mockReturnValue(answer.promise);
      await act(async () => result.current.remove(WORK));
      expect(cached(client)).toEqual(["lake"]);

      if (cabinAnswers === "before") await act(async () => cabin.resolve(CABIN));
      await act(async () => answer.resolve(undefined));
      await act(() => settle());
      if (cabinAnswers === "before") expect(cached(client)).toEqual(["lake", "cabin"]);
      else expect(cached(client)).toEqual(["lake"]);
      expect(guessed(client)).toBe(true);
      if (cabinAnswers === "after") await act(async () => cabin.resolve(CABIN));
      await act(() => settle());

      expect(cached(client)).toEqual(["lake", "cabin"]);
      expect(guessed(client)).toBe(true);

      // Every Add is answered now, and the book is still not the server's: the one left when
      // the other goes is drawn without the chip, until the server lists it.
      jest.mocked(apiDelete).mockResolvedValue(undefined);
      await remove(result, LAKE);
      expect(cached(client)).toEqual(["cabin"]);
      expect(guessed(client)).toBe(true);

      server = [{ ...CABIN, is_default: true }];
      jest.mocked(apiGet).mockImplementation(async () => ({ items: server }));
      await act(async () => {
        await result.current.book.refetch();
      });
      expect(cached(client)).toEqual(["cabin*"]);
      expect(guessed(client)).toBe(false);
    },
  );

  it("nor when the address drawn was asked before the book was cached too", async () => {
    const { result, client, cabin } = await lakeDrawnCabinUnanswered({ both: true });

    await remove(result, HOME);
    expect(cached(client)).toEqual(["lake"]);
    expect(guessed(client)).toBe(true);

    await act(async () => cabin.resolve(CABIN));
    await act(() => settle());
    expect(cached(client)).toEqual(["lake", "cabin"]);
    expect(guessed(client)).toBe(true);
  });

  it("a list from the server says where it is: the book is vouched for again", async () => {
    const { result, client, cabin } = await lakeDrawnCabinUnanswered();
    server = [HOME, CABIN, LAKE];
    jest.mocked(apiGet).mockImplementation(async () => ({ items: server }));

    await act(async () => {
      await result.current.book.refetch();
    });
    expect(cached(client)).toEqual(["home*", "cabin", "lake"]);
    expect(guessed(client)).toBe(false);

    // Its answer is still to come, and changes nothing: the list has the address, in its place.
    getsFail();
    await remove(result, HOME);
    expect(cached(client)).toEqual(["cabin*", "lake"]);
    await act(async () => cabin.resolve(CABIN));
    await act(() => settle());
    expect(cached(client)).toEqual(["cabin*", "lake"]);
  });
});
