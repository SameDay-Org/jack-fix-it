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
