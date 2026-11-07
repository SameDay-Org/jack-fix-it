import { deferred } from "../../../api/__tests__/helpers";

jest.mock("@stripe/stripe-react-native");
jest.mock("@/api", () => ({ onSignOut: jest.fn() }));
jest.mock("../config", () => ({ paymentConfig: { resetTimeoutMs: 10_000, resetAttempts: 2 } }));

type Loaded = typeof import("../sheetCustomer") & {
  reset: jest.Mock<Promise<null>, []>;
  onSignOut: jest.Mock;
};

/**
 * Loads a fresh copy of the module, as the root layout does at launch, with the mocks of that
 * copy's registry. `before` sets the native reset's answers before the import runs it.
 */
function load(before?: (reset: jest.Mock<Promise<null>, []>) => void): Loaded {
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    const sdk = jest.requireMock<{ resetPaymentSheetCustomer: jest.Mock<Promise<null>, []> }>(
      "@stripe/stripe-react-native",
    );
    before?.(sdk.resetPaymentSheetCustomer);
    const api = jest.requireMock<{ onSignOut: jest.Mock }>("@/api");
    const module = jest.requireActual<typeof import("../sheetCustomer")>("../sheetCustomer");
    loaded = { ...module, reset: sdk.resetPaymentSheetCustomer, onSignOut: api.onSignOut };
  });
  if (!loaded) throw new Error("sheetCustomer did not load");
  return loaded;
}

/** Lets the queued resets run (each is a few promise hops). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const failure = () => new TypeError("native detail");
// Each test loads a fresh copy of the module (isolateModules): the first one transforms it cold,
// which went past Jest's 5 s default once under `pnpm -r test` contention.
jest.setTimeout(30_000);

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("sheetCustomer", () => {
  it("resets once at launch and registers the reset for every session end", async () => {
    const { reset, onSignOut, resetSheetCustomer } = load();
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledWith(resetSheetCustomer);

    resetSheetCustomer(); // a sign-out
    await flush();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("a sheet opened right after launch waits for the launch reset", async () => {
    const launch = deferred<null>();
    const { sheetCustomerReady } = load((reset) => reset.mockReturnValueOnce(launch.promise));
    let ready = false;
    const waiting = sheetCustomerReady().then((session) => {
      ready = true;
      return session;
    });
    await flush();
    expect(ready).toBe(false);

    launch.resolve(null);
    const session = await waiting;
    expect(session.kind).toBe("ready");
    expect(session.kind === "ready" && session.ended()).toBe(false);
  });

  it("a reset asked for while a sheet waits ends that sheet's wait", async () => {
    const launch = deferred<null>();
    const { resetSheetCustomer, sheetCustomerReady } = load((reset) =>
      reset.mockReturnValueOnce(launch.promise),
    );
    const waiting = sheetCustomerReady();
    resetSheetCustomer();
    expect(await waiting).toEqual({ kind: "ended" });
    launch.resolve(null);
    expect((await sheetCustomerReady()).kind).toBe("ready");
  });

  it("a reset asked for after the sheet started marks its session ended", async () => {
    const { resetSheetCustomer, sheetCustomerReady } = load();
    const session = await sheetCustomerReady();
    expect(session.kind === "ready" && session.ended()).toBe(false);
    resetSheetCustomer();
    expect(session.kind === "ready" && session.ended()).toBe(true);
  });

  it("a failed launch reset is owed: the sheet tries it again and starts once it succeeds", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { reset, sheetCustomerReady } = load((r) => r.mockRejectedValueOnce(failure()));
    await flush();
    expect(warn).toHaveBeenCalledWith("Payment sheet reset failed: TypeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("native detail");

    expect((await sheetCustomerReady()).kind).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("a sign-out reset that keeps failing makes the sheet unavailable, every time", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { reset, resetSheetCustomer, sheetCustomerReady } = load();
    await flush();
    reset.mockRejectedValue(failure());
    resetSheetCustomer(); // a sign-out; its reset fails
    await flush();
    expect(reset).toHaveBeenCalledTimes(2);

    expect(await sheetCustomerReady()).toEqual({ kind: "unavailable" });
    expect(reset).toHaveBeenCalledTimes(4); // two more tries, then no more
    expect(await sheetCustomerReady()).toEqual({ kind: "unavailable" }); // not bypassed later
    expect(reset).toHaveBeenCalledTimes(6);

    reset.mockResolvedValue(null);
    expect((await sheetCustomerReady()).kind).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(7);
  });

  it("a reset that does not answer ends the wait as unavailable and stays owed", async () => {
    jest.useFakeTimers();
    const stuck = deferred<null>();
    const { reset, sheetCustomerReady } = load((r) => r.mockReturnValueOnce(stuck.promise));
    const waiting = sheetCustomerReady();
    await jest.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void waiting.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await waiting).toEqual({ kind: "unavailable" });

    // The next sheet joins the same unanswered reset rather than running a second one.
    const again = sheetCustomerReady();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await again).toEqual({ kind: "unavailable" });
    expect(reset).toHaveBeenCalledTimes(1);

    stuck.resolve(null); // it answers late: the cleanup is done, and nothing else starts
    await jest.advanceTimersByTimeAsync(0);
    expect(reset).toHaveBeenCalledTimes(1);
    expect((await sheetCustomerReady()).kind).toBe("ready");
  });

  it("a stuck reset that finally fails is tried again by the next sheet", async () => {
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const stuck = deferred<null>();
    const { reset, sheetCustomerReady } = load((r) => r.mockReturnValueOnce(stuck.promise));
    const waiting = sheetCustomerReady();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toEqual({ kind: "unavailable" });

    stuck.reject(failure());
    await jest.advanceTimersByTimeAsync(0);
    expect((await sheetCustomerReady()).kind).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("an aborted wait ends at once and leaves the cleanup owed", async () => {
    const stuck = deferred<null>();
    const { reset, sheetCustomerReady } = load((r) => r.mockReturnValueOnce(stuck.promise));
    const leaving = new AbortController();
    const waiting = sheetCustomerReady(leaving.signal);
    leaving.abort();
    expect(await waiting).toEqual({ kind: "ended" });

    const next = sheetCustomerReady();
    stuck.resolve(null);
    expect((await next).kind).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("resets asked for while one runs run after it, one at a time", async () => {
    const first = deferred<null>();
    const second = deferred<null>();
    const { reset, resetSheetCustomer, sheetCustomerReady } = load((r) =>
      r.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );
    resetSheetCustomer();
    resetSheetCustomer();
    let ready = false;
    const waiting = sheetCustomerReady().then((session) => {
      ready = true;
      return session;
    });
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);

    first.resolve(null);
    await flush();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(ready).toBe(false);

    second.resolve(null);
    expect((await waiting).kind).toBe("ready");
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
