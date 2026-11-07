import { deferred } from "../../../api/__tests__/helpers";

jest.mock("@stripe/stripe-react-native");
jest.mock("@/api", () => ({ onSignOut: jest.fn() }));

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
    expect((await waiting).ended()).toBe(false);
  });

  it("a reset asked for while a sheet waits ends that sheet's session", async () => {
    const { resetSheetCustomer, sheetCustomerReady } = load();
    const waiting = sheetCustomerReady();
    resetSheetCustomer();
    expect((await waiting).ended()).toBe(true);
    expect((await sheetCustomerReady()).ended()).toBe(false);
  });
});
