import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { attachQueryClient, login, register, sessionStore } from "../../../api/session";
import {
  authResponse,
  callBody,
  callHeader,
  callPath,
  callsTo,
  deferred,
  errorResponse,
  installFetchMock,
  jsonResponse,
  resetSecureStore,
  settle,
  user,
  type FetchMock,
} from "../../../api/__tests__/helpers";
import { useHomeStep, useNameStep } from "../useSignUpSteps";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

// #292 Vault B1: a step's save is bound to the session its action started in. Account A starts
// it; account B signs in on the device before it ends; nothing of A's form may reach the server
// with B's token, and the step must not end for A as if it had been saved. Adapted from the
// Vault's probes (handoffs/292-vault-r1).

const SIGNED_OUT = {
  status: "signedOut" as const,
  user: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  cleanupPending: false,
  restoreFailure: null,
  onboardingUserId: null,
};
const signUp = {
  email: user.email,
  password: "synthetic test password",
  role: "customer" as const,
  locale: "en" as const,
};
const second = { ...user, id: "22222222-2222-4222-8222-222222222222", email: "b@example.invalid" };
const fields = {
  line1: "101 Synthetic A Street",
  line2: "",
  city: "Miami",
  state: "FL",
  zipCode: "33101",
};
const savedHome = { id: "address-a", label: "Home", ...fields };
const signInB = () => login({ email: second.email, password: signUp.password });

const newClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });

/** A's session, and a hook rendered inside a fresh Query client. */
async function asA<Result>(hook: () => Result) {
  const client = newClient();
  attachQueryClient(client);
  await register(signUp, { onboarding: true });
  await settle();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = await renderHook(hook, { wrapper });
  return { client, rendered };
}

async function typeHome(set: (field: keyof typeof fields, value: string) => void) {
  await act(async () => {
    for (const [key, value] of Object.entries(fields)) set(key as keyof typeof fields, value);
  });
}

/** Every chain request (addresses, profile) sent with B's token. */
const sentAsB = (fetch: FetchMock) =>
  fetch.mock.calls
    .filter((call) => /\/v1\/(addresses|auth\/me)/.test(callPath(call)))
    .filter((call) => callHeader(call, "Authorization") === "Bearer access-2")
    .map((call) => ({ path: callPath(call), method: call[1]?.method }));

beforeEach(() => {
  resetSecureStore();
  sessionStore.setState(SIGNED_OUT);
});

describe("a sign-up step's save belongs to the session it started in", () => {
  it("the ordinary customer Home save sends the address, then the profile, both as A, and moves on", async () => {
    const fetch = installFetchMock();
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/v1/addresses")) return jsonResponse(201, savedHome);
      if (url.endsWith("/auth/me"))
        return jsonResponse(200, { ...user, ...(callBody([url, init]) as object) });
      throw new Error(`Unexpected route ${url}`);
    });
    const onSaved = jest.fn();
    const { client, rendered } = await asA(() => useHomeStep("customer", onSaved));
    await typeHome(rendered.result.current.set);

    await act(() => rendered.result.current.submit());

    const chain = [...callsTo(fetch, "/v1/addresses"), ...callsTo(fetch, "/v1/auth/me")];
    expect(chain.map((call) => callHeader(call, "Authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-1",
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(sessionStore.getState().user?.home_city).toBe("Miami");
    await rendered.unmount();
    client.clear();
  });

  it("a save released after B signed in and the screen unmounted sends nothing more (Vault probe 1)", async () => {
    const fetch = installFetchMock();
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: second });
      if (url.endsWith("/v1/addresses")) return jsonResponse(201, savedHome);
      if (url.endsWith("/auth/me"))
        return jsonResponse(200, { ...second, ...(callBody([url, init]) as object) });
      throw new Error(`Unexpected route ${url}`);
    });
    const onSaved = jest.fn();
    const { client, rendered } = await asA(() => useHomeStep("customer", onSaved));
    const invalidating = deferred<void>();
    const finishInvalidation = deferred<void>();
    // useSaveAddress awaits its invalidation before mutateAsync resolves: hold it there.
    const invalidate = jest.spyOn(client, "invalidateQueries").mockImplementation(() => {
      invalidating.resolve();
      return finishInvalidation.promise;
    });
    await typeHome(rendered.result.current.set);

    let saving!: Promise<void>;
    await act(async () => {
      saving = rendered.result.current.submit();
      await invalidating.promise;
    });
    expect(callHeader(callsTo(fetch, "/v1/addresses")[0], "Authorization")).toBe("Bearer access-1");
    await act(() => signInB());
    await rendered.unmount();
    finishInvalidation.resolve();
    await act(() => saving);
    invalidate.mockRestore();

    expect(callsTo(fetch, "/v1/auth/me")).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(sessionStore.getState().user?.id).toBe(second.id);
    expect(sessionStore.getState().user?.home_city).toBeNull();
    client.clear();
  });

  // Each held answer of the chain (the address POST, the conflict path's GET and PATCH) is released
  // as B's login answer lands up to 20 microtasks later: every ordering the Vault found unsafe.
  const holds = [
    { name: "the address POST", held: "POST /v1/addresses", conflict: false },
    {
      name: "a conflict's POST (409 address_label_taken)",
      held: "POST /v1/addresses",
      conflict: true,
    },
    { name: "a conflict's GET of the book", held: "GET /v1/addresses", conflict: true },
    {
      name: "a conflict's PATCH of the saved Home",
      held: "PATCH /v1/addresses/address-a",
      conflict: true,
    },
  ];

  it.each(holds)(
    "B's login landing around $name never lets A's form go out as B (Vault probe 2)",
    async ({ held, conflict }) => {
      const crossed: unknown[] = [];
      const failures: unknown[] = [];
      for (let tick = 0; tick <= 20; tick += 1) {
        resetSecureStore();
        sessionStore.setState(SIGNED_OUT);
        const fetch = installFetchMock();
        const answer = deferred<Response>();
        const reached = deferred<void>();
        const loginAnswer = deferred<Response>();
        const respond = (route: string): Response => {
          if (route === "POST /v1/addresses") {
            return conflict
              ? errorResponse(409, "address_label_taken")
              : jsonResponse(201, savedHome);
          }
          if (route === "GET /v1/addresses") return jsonResponse(200, { items: [savedHome] });
          return jsonResponse(200, savedHome);
        };
        fetch.mockImplementation(async (url, init) => {
          const route = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
          if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
          if (url.endsWith("/login")) return loginAnswer.promise;
          if (url.endsWith("/auth/me")) {
            const owner =
              callHeader([url, init], "Authorization") === "Bearer access-2" ? second : user;
            return jsonResponse(200, { ...owner, ...(callBody([url, init]) as object) });
          }
          if (route === held) {
            reached.resolve();
            return answer.promise;
          }
          return respond(route);
        });
        const { client, rendered } = await asA(() => useHomeStep("customer", jest.fn()));
        await typeHome(rendered.result.current.set);

        let saving!: Promise<void>;
        await act(async () => {
          saving = rendered.result.current.submit();
          await reached.promise;
        });
        await act(async () => {
          const entering = signInB();
          answer.resolve(respond(held));
          for (let i = 0; i < tick; i += 1) await Promise.resolve();
          loginAnswer.resolve(jsonResponse(200, { ...authResponse(2), user: second }));
          await Promise.all([entering, saving]);
        });

        for (const call of sentAsB(fetch)) crossed.push({ tick, ...call });
        if (rendered.result.current.failure !== null)
          failures.push({ tick, failure: rendered.result.current.failure });
        expect(sessionStore.getState().user?.id).toBe(second.id);
        await rendered.unmount();
        client.clear();
      }
      expect(crossed).toEqual([]);
      // A save the session left behind ends silently: no failure for the next account to read.
      expect(failures).toEqual([]);
    },
  );

  it("a name save answered after B signed in is not marked done and shows no failure", async () => {
    const fetch = installFetchMock();
    const patchAnswer = deferred<Response>();
    const reached = deferred<void>();
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/register")) return jsonResponse(200, authResponse(1));
      if (url.endsWith("/login")) return jsonResponse(200, { ...authResponse(2), user: second });
      if (url.endsWith("/auth/me")) {
        reached.resolve();
        return patchAnswer.promise;
      }
      throw new Error(`Unexpected route ${url}`);
    });
    const onSaved = jest.fn();
    const { client, rendered } = await asA(() => useNameStep(onSaved));
    await act(async () => {
      rendered.result.current.set("first", "Ana");
      rendered.result.current.set("last", "Lima");
    });

    let saving!: Promise<void>;
    await act(async () => {
      saving = rendered.result.current.submit();
      await reached.promise;
    });
    await act(() => signInB());
    patchAnswer.resolve(jsonResponse(200, { ...user, first_name: "Ana", last_name: "Lima" }));
    await act(() => saving);

    expect(onSaved).not.toHaveBeenCalled();
    expect(rendered.result.current.failure).toBeNull();
    expect(rendered.result.current.submitting).toBe(false);
    expect(sessionStore.getState().user?.first_name).toBe(second.first_name);
    await rendered.unmount();
    client.clear();
  });
});
