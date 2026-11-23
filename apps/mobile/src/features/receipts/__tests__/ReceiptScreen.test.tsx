import "@/i18n";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { Image } from "react-native";

import { ApiError, apiGet } from "@/api";
import { dismissToast, toastStore } from "@/components/ui/toast";

import type { ReceiptOut } from "../api";
import { paymentMethodText, proFirstName } from "../format";
import { ReceiptScreen } from "../ReceiptScreen";
import { deferred } from "../../../api/__tests__/helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
  sessionGeneration: () => 1,
  isCurrentGeneration: (generation: number) => generation === 1,
  useSessionGeneration: () => 1,
}));
const mockPush = jest.fn();
jest.mock("@/features/quotes/navigation", () => ({ useGuardedPush: () => mockPush }));
jest.mock("expo-router", () => ({ useLocalSearchParams: () => ({ id: mockRequestId }) }));
jest.mock("@/features/auth/components/BackButton", () => ({ BackButton: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);
// expo-sharing and react-native-view-shot: the root manual mocks (apps/mobile/__mocks__).

const mockRequestId = "6f1c2a40-0000-4000-8000-000000000062";
const HIDDEN = { includeHiddenElements: true } as const;
/** What the root view-shot mock resolves a base64 capture to. */
const MOCK_CAPTURE_BASE64 = "iVBORw0KGgo=";
/** The receipt's private cache folder for shared PNGs (expo-file-system's in-memory mock). */
const shareDir = () => new Directory(Paths.cache, "receipt-share");
/** The PNGs a share left behind. */
const sharedPngs = () =>
  shareDir().exists
    ? shareDir()
        .list()
        .map((entry) => entry.uri)
    : [];

const receipt = (overrides: Partial<ReceiptOut> = {}): ReceiptOut => ({
  receipt_number: "JF-000124",
  paid_at: "2026-11-18T15:00:00Z",
  status: "paid",
  category: { slug: "handyman", names: { en: "Handyman", es: "Reparaciones generales" } },
  pro_name: "Dan R.",
  scheduled_start_at: "2026-11-19T14:00:00Z",
  completed_at: "2026-11-19T16:00:00Z",
  address: { line1: "1200 Seabreeze Blvd", city: "Fort Lauderdale", state: "FL" },
  lines: [
    { kind: "service", amount_cents: 12_500, at: null },
    { kind: "tip", amount_cents: 1_250, at: null },
  ],
  total_paid_cents: 13_750,
  currency: "usd",
  payment_method: { brand: "visa", last4: "4242", wallet: null },
  tip: { can_tip: false, closes_at: null },
  issuer: { legal_name: "John Got It LLC", support_email: "help@example.com" },
  ...overrides,
});

async function renderScreen(answer: () => Promise<unknown>) {
  jest.mocked(apiGet).mockImplementation(answer as unknown as typeof apiGet);
  // gcTime Infinity: no five-minute cleanup timer is left behind to keep Jest running.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await render(
    <QueryClientProvider client={client}>
      <ReceiptScreen />
    </QueryClientProvider>,
  );
  await act(async () => undefined);
}

const paper = () => within(screen.getByTestId("receipt-paper"));

beforeEach(() => {
  jest.mocked(apiGet).mockReset();
  mockPush.mockReset();
  jest.mocked(shareAsync).mockReset().mockResolvedValue(undefined);
  jest.mocked(isAvailableAsync).mockReset().mockResolvedValue(true);
  // getSize is overloaded (promise and callback forms), so the spy spells out the promise form.
  jest
    .spyOn(Image, "getSize")
    .mockImplementation((() =>
      Promise.resolve({ width: 1080, height: 2400 })) as typeof Image.getSize);
  if (shareDir().exists) shareDir().delete();
});

// A toast's hide timer would outlive the test.
afterEach(() => dismissToast());

describe("ReceiptScreen (#62)", () => {
  it("is the paper of the job: who, what, the lines, the total, how it was paid, who issues it", async () => {
    await renderScreen(async () => receipt());
    await screen.findByTestId("receipt-paper");

    expect(jest.mocked(apiGet)).toHaveBeenCalledWith("/v1/requests/{request_id}/receipt", {
      auth: true,
      signal: expect.any(AbortSignal),
      generation: 1,
      params: { request_id: mockRequestId },
    });
    expect(paper().getByText("Receipt JF-000124")).toBeTruthy();
    expect(paper().getByText("John Got It LLC")).toBeTruthy();
    expect(paper().getByText("With Dan R.")).toBeTruthy();
    expect(paper().getByTestId("receipt-address")).toHaveTextContent(
      "1200 Seabreeze Blvd, Fort Lauderdale",
    );
    // Each line read whole, the amounts the API's.
    expect(screen.getByLabelText("Handyman service, $125.00")).toBeTruthy();
    expect(screen.getByLabelText("Tip for Dan, $12.50")).toBeTruthy();
    expect(screen.getByLabelText("Total paid, $137.50")).toBeTruthy();
    expect(paper().getByTestId("receipt-method")).toHaveTextContent("Paid with Visa •••• 4242");
    expect(paper().getByTestId("receipt-status")).toHaveTextContent("Paid");
    expect(paper().getByText("Questions? help@example.com")).toBeTruthy();
    // Share is a full button with its word, not a bare icon.
    expect(within(screen.getByTestId("receipt-share")).getByText("Share")).toBeTruthy();
    // Never John's fee: the customer pays the total.
    expect(screen.queryByText(/fee/i, HIDDEN)).toBeNull();
  });

  it("states the API's lines and total as they come: a tax line, and a total it adds up nowhere", async () => {
    await renderScreen(async () =>
      receipt({
        lines: [
          { kind: "service", amount_cents: 12_500, at: null },
          { kind: "tax", amount_cents: 875, at: null },
          { kind: "tip", amount_cents: 1_250, at: null },
        ],
        // Deliberately NOT the sum of the lines ($146.25): the paper shows the API's total.
        total_paid_cents: 14_601,
      }),
    );
    await screen.findByTestId("receipt-paper");

    expect(screen.getByLabelText("Handyman service, $125.00")).toBeTruthy();
    expect(screen.getByLabelText("Tax, $8.75")).toBeTruthy();
    expect(screen.getByLabelText("Tip for Dan, $12.50")).toBeTruthy();
    expect(screen.getByLabelText("Total paid, $146.01")).toBeTruthy();
    expect(screen.queryByLabelText("Total paid, $146.25")).toBeNull();
  });

  it("a paid job not done yet says when it is scheduled, never Done", async () => {
    await renderScreen(async () => receipt({ completed_at: null }));
    await screen.findByTestId("receipt-paper");

    expect(paper().getByTestId("receipt-job")).toHaveTextContent(/Scheduled for Nov 19, 2026/);
    expect(paper().queryByText(/^Done /)).toBeNull();
  });

  it("without an issuer or a pro's name the paper leaves those lines out, inventing nothing", async () => {
    await renderScreen(async () => receipt({ issuer: null, pro_name: null }));
    await screen.findByTestId("receipt-paper");

    expect(paper().queryByText("John Got It LLC")).toBeNull();
    expect(paper().queryByText(/^Questions\?/)).toBeNull();
    expect(paper().queryByText(/^With /)).toBeNull();
    expect(screen.getByLabelText("Tip, $12.50")).toBeTruthy();
    // The rest of the paper is whole.
    expect(paper().getByText("Receipt JF-000124")).toBeTruthy();
    expect(paper().getByText("Thank you for using John Got It.")).toBeTruthy();
    expect(screen.getByLabelText("Total paid, $137.50")).toBeTruthy();
  });

  it("an amount that went back is its own dated line, with the status that says so", async () => {
    await renderScreen(async () =>
      receipt({
        status: "partly_returned",
        lines: [
          { kind: "service", amount_cents: 9_500, at: null },
          { kind: "returned", amount_cents: -4_794, at: "2026-11-20T10:00:00Z" },
        ],
        total_paid_cents: 4_706,
      }),
    );
    await screen.findByTestId("receipt-paper");

    expect(
      screen.getByLabelText("Returned to your payment method, Nov 20, 2026, -$47.94"),
    ).toBeTruthy();
    expect(paper().getByTestId("receipt-status")).toHaveTextContent("Partly returned");
    expect(screen.getByLabelText("Total paid, $47.06")).toBeTruthy();
  });

  it("without a category or card details: the plain service line and 'Paid by card'", async () => {
    await renderScreen(async () =>
      receipt({ category: null, payment_method: null, status: "under_review" }),
    );
    await screen.findByTestId("receipt-paper");

    expect(screen.getByLabelText("Service, $125.00")).toBeTruthy();
    expect(paper().getByTestId("receipt-method")).toHaveTextContent("Paid by card");
    expect(paper().getByTestId("receipt-status")).toHaveTextContent("Under review");
  });

  it("the shared image leaves the address out (Q-R2)", async () => {
    await renderScreen(async () => receipt());
    await screen.findByTestId("receipt-paper");

    const shared = within(screen.getByTestId("receipt-share-render", HIDDEN));
    expect(shared.getByText("Receipt JF-000124", HIDDEN)).toBeTruthy();
    expect(shared.queryByText(/Seabreeze/, HIDDEN)).toBeNull();
  });

  it("Share hands the share sheet a PNG of the receipt's render, gone once the sheet closes", async () => {
    await renderScreen(async () => receipt());
    await screen.findByTestId("receipt-paper");
    // The sheet stays open until the person picks an app or closes it.
    const sheet = deferred<void>();
    jest.mocked(shareAsync).mockReturnValue(sheet.promise);

    await fireEvent.press(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(shareAsync).toHaveBeenCalledTimes(1));

    expect(shareAsync).toHaveBeenCalledWith(expect.any(String), {
      mimeType: "image/png",
      UTI: "public.png",
      dialogTitle: "Share your receipt",
    });
    // The capture of the receipt's render, in the receipt's own private folder, and only there.
    const [shared = ""] = jest.mocked(shareAsync).mock.calls[0] ?? [];
    expect(shared).toMatch(/\/receipt-share\/receipt-[^/]+\.png$/);
    expect(sharedPngs()).toEqual([shared]);
    await expect(new File(shared).base64()).resolves.toBe(MOCK_CAPTURE_BASE64);
    sheet.resolve();
    await waitFor(() => expect(sharedPngs()).toEqual([]));
    expect(toastStore.getState().current).toBeNull();
  });

  it.each([
    ["the share sheet fails", () => jest.mocked(shareAsync).mockRejectedValue(new Error("x"))],
    ["there is no share sheet", () => jest.mocked(isAvailableAsync).mockResolvedValue(false)],
  ])("a share that cannot finish (%s) says so calmly and leaves no PNG", async (_, arrange) => {
    arrange();
    await renderScreen(async () => receipt());
    await screen.findByTestId("receipt-paper");

    await fireEvent.press(screen.getByRole("button", { name: "Share" }));

    await waitFor(() =>
      expect(toastStore.getState().current).toMatchObject({
        message: "We couldn't share the receipt. Try again.",
        tone: "neutral",
      }),
    );
    expect(sharedPngs()).toEqual([]);
  });

  it("offers Add a tip only while the window is open, opening the job", async () => {
    await renderScreen(async () => receipt({ tip: { can_tip: true, closes_at: null } }));
    await screen.findByTestId("receipt-paper");

    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Add a tip" })));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/requests/[id]/job",
      params: { id: mockRequestId },
    });
  });

  it("no Add a tip once the window closed or a tip was added", async () => {
    await renderScreen(async () => receipt());
    await screen.findByTestId("receipt-paper");
    expect(screen.queryByRole("button", { name: "Add a tip" })).toBeNull();
  });

  it("before the payment went through, it says the receipt comes then", async () => {
    await renderScreen(async () => {
      throw new ApiError(404, "receipt_not_available");
    });
    expect(await screen.findByTestId("receipt-not-yet")).toHaveTextContent(
      "Your receipt shows here once the payment goes through.",
    );
  });

  it("an error offers Try again, which asks again", async () => {
    let fail = true;
    await renderScreen(async () => {
      if (fail) throw new ApiError(500, "internal");
      return receipt();
    });
    expect(await screen.findByText("We couldn't load your receipt")).toBeTruthy();

    fail = false;
    await act(async () => fireEvent.press(screen.getByRole("button", { name: "Try again" })));
    expect(await screen.findByTestId("receipt-paper")).toBeTruthy();
  });

  it("loads in the paper's shape, read as one progress indicator", async () => {
    await renderScreen(() => new Promise(() => undefined));
    const loading = screen.getByTestId("receipt-loading");
    expect(loading.props.accessibilityRole).toBe("progressbar");
    expect(loading.props.accessibilityLabel).toBe("Loading your receipt");
  });
});

describe("receipt format", () => {
  // The mask and the digits never part (a no-break space): "•••• 4242" wraps as one.
  it.each([
    [{ brand: "visa", last4: "4242", wallet: null }, "Visa ••••\u00A04242"],
    [{ brand: "amex", last4: "0005", wallet: null }, "American Express ••••\u00A00005"],
    [{ brand: "visa", last4: "1111", wallet: "apple_pay" }, "Apple Pay (Visa ••••\u00A01111)"],
    [{ brand: null, last4: "9999", wallet: "google_pay" }, "Google Pay (••••\u00A09999)"],
    [{ brand: "newbrand", last4: "1234", wallet: null }, "newbrand ••••\u00A01234"],
    [{ brand: "visa", last4: null, wallet: null }, null],
    [null, null],
  ] as const)("payment method %j reads %j", (method, text) => {
    expect(paymentMethodText(method)).toBe(text);
  });

  it("names the pro by first name on the tip line", () => {
    expect(proFirstName("Dan R.")).toBe("Dan");
    expect(proFirstName("María")).toBe("María");
  });
});
