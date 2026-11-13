import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AccessibilityInfo } from "react-native";

import { ApiError, apiGet, apiPatch, apiPost, NetworkError, useSession } from "@/api";
import i18n from "@/i18n";

import { deferred, settle } from "../../../api/__tests__/helpers";
import { signedIn } from "../../home/__tests__/helpers";
import { EditAddressScreen, NewAddressScreen } from "../AddressEditScreen";
import type { SavedAddress } from "../api";
import { bookClient, cachedBook, HOME, renderAddresses, savedAddress, WORK } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
  isCurrentGeneration: jest.fn(() => true),
  sessionGeneration: jest.fn(() => 1),
  useSession: jest.fn(),
}));
// Where a redirect sends the screen; it draws nothing.
const mockRedirect = jest.fn((_props: { href: string }) => null);
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  Redirect: (props: { href: string }) => mockRedirect(props),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

/** What GET /v1/addresses answers now. */
let server: SavedAddress[];
let announce: jest.SpyInstance;

beforeEach(() => {
  server = [HOME, WORK];
  jest.mocked(useSession).mockReturnValue(signedIn());
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  jest
    .mocked(apiGet)
    .mockReset()
    .mockImplementation(async () => ({ items: server }));
  jest.mocked(apiPost).mockReset();
  jest.mocked(apiPatch).mockReset();
  jest.mocked(router.back).mockClear();
  // React Native's statics are Jest mocks already: spying again keeps their calls, so clear them.
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  announce.mockClear();
});

afterEach(async () => {
  await act(() => settle());
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
});

const type = async (testID: string, text: string) =>
  fireEvent.changeText(screen.getByTestId(testID), text);
const save = () => fireEvent.press(screen.getByRole("button", { name: "Save address" }));
/** A field's error, as a screen reader hears it (the field's hint). */
const fieldError = (testID: string) =>
  screen.getByTestId(testID).props.accessibilityHint as string | undefined;

async function fillOffice() {
  await type("address-form-label", "Office");
  await type("address-form-line1", " 1 Bay St ");
  await type("address-form-city", "Miami");
  await type("address-form-state", "fl");
  await type("address-form-zip", "33101");
}

const OFFICE = savedAddress({
  id: "office",
  label: "Office",
  line1: "1 Bay St",
  city: "Miami",
  state: "FL",
  zip_code: "33101",
  is_default: false,
});

describe("Add an address", () => {
  it("checks the fields on Save and sends nothing until they are filled", async () => {
    await renderAddresses(<NewAddressScreen />, bookClient([HOME, WORK]));
    expect(screen.getByRole("header", { name: "Add an address" })).toBeOnTheScreen();

    await save();

    expect(apiPost).not.toHaveBeenCalled();
    expect(fieldError("address-form-label")).toBe("Fill in this field.");
    expect(fieldError("address-form-line1")).toBe("Fill in this field.");
    expect(announce).toHaveBeenCalledWith("Some fields need a look.");
  });

  it("refuses a name the book already has before asking the server", async () => {
    await renderAddresses(<NewAddressScreen />, bookClient([HOME, WORK]));
    await fillOffice();
    await type("address-form-label", " home ");

    await save();

    expect(apiPost).not.toHaveBeenCalled();
    expect(fieldError("address-form-label")).toBe("You already have an address with this name.");
  });

  it("saves the address under its name, adds it to the book and goes back", async () => {
    const answer = deferred<SavedAddress>();
    jest.mocked(apiPost).mockReturnValue(answer.promise);
    const client = bookClient([HOME, WORK]);
    await renderAddresses(<NewAddressScreen />, client);
    await fillOffice();

    await save();

    expect(apiPost).toHaveBeenCalledWith(
      "/v1/addresses",
      {
        line1: "1 Bay St",
        city: "Miami",
        state: "FL",
        zip_code: "33101",
        label: "Office",
        is_default: false,
      },
      { auth: true, generation: 1 },
    );
    // Busy while it saves: a second tap sends nothing more.
    await fireEvent.press(screen.getByTestId("address-form-save"));
    expect(apiPost).toHaveBeenCalledTimes(1);
    server = [HOME, WORK, OFFICE];
    await act(async () => answer.resolve(OFFICE));

    expect(cachedBook(client)).toEqual(["home*", "work", "office"]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Office saved");
    // The new name is not reported as its own clash while the form leaves.
    expect(fieldError("address-form-label")).toBeUndefined();
  });

  it.each([
    [
      new ApiError(409, "address_label_taken"),
      "label",
      "You already have an address with this name.",
    ],
    [
      new ApiError(422, "validation_error"),
      "label",
      "Use a simple name, like Home or Work. Leave out streets, units and contact details.",
    ],
    [
      new ApiError(409, "address_limit_reached"),
      "notice",
      "Your address book is full. Delete an address to add this one.",
    ],
    [new NetworkError(false), "notice", "You're offline. Check your connection and try again."],
    [
      new ApiError(429, "rate_limited"),
      "notice",
      "That's a lot of changes at once. Try again in a moment.",
    ],
    [new ApiError(500, "internal_error"), "notice", "We couldn't save this address. Try again."],
  ])("shows a refusal (%s) where it belongs and stays", async (error, where, message) => {
    jest.mocked(apiPost).mockRejectedValue(error);
    await renderAddresses(<NewAddressScreen />, bookClient([HOME]));
    await fillOffice();

    await save();

    if (where === "label") {
      await waitFor(() => expect(fieldError("address-form-label")).toBe(message));
      // Typing a new name clears the server's verdict.
      await type("address-form-label", "Office 2");
      expect(fieldError("address-form-label")).toBeUndefined();
    } else {
      expect(await screen.findByTestId("address-form-failure")).toHaveTextContent(message);
    }
    expect(router.back).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save address" })).toBeEnabled();
  });

  it("waits for the book before showing the form", async () => {
    jest.mocked(apiGet).mockReturnValue(new Promise(() => undefined));
    await renderAddresses(<NewAddressScreen />);

    expect(screen.getByTestId("address-form-loading").props.accessibilityLabel).toBe("Loading");
    expect(screen.queryByTestId("address-form-label")).toBeNull();
  });
});

describe("Edit an address", () => {
  beforeEach(() => jest.mocked(useLocalSearchParams).mockReturnValue({ id: "work" }));

  it("opens with the address's name and fields", async () => {
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    expect(screen.getByRole("header", { name: "Edit address" })).toBeOnTheScreen();
    expect(screen.getByTestId("address-form-label").props.value).toBe("Work");
    expect(screen.getByTestId("address-form-line1").props.value).toBe("500 Market St");
    expect(screen.getByTestId("address-form-line2").props.value).toBe("Suite 12");
    expect(screen.getByTestId("address-form-zip").props.value).toBe("07102");
  });

  it("sends every field, a cleared unit as null, and goes back", async () => {
    const edited = { ...WORK, label: "Office", line2: null };
    jest.mocked(apiPatch).mockResolvedValue(edited);
    const client = bookClient([HOME, WORK]);
    await renderAddresses(<EditAddressScreen />, client);
    await type("address-form-label", "Office");
    await type("address-form-line2", "  ");
    server = [HOME, edited];

    await save();

    expect(apiPatch).toHaveBeenCalledWith(
      "/v1/addresses/{address_id}",
      {
        label: "Office",
        line1: "500 Market St",
        line2: null,
        city: "Newark",
        state: "NJ",
        zip_code: "07102",
      },
      { auth: true, generation: 1, params: { address_id: "work" } },
    );
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("address-form-failure")).toBeNull();
  });

  it("keeps its own name: only another address's counts as taken", async () => {
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    await type("address-form-label", "HOME");
    await save();
    expect(fieldError("address-form-label")).toBe("You already have an address with this name.");

    await type("address-form-label", "work");
    jest.mocked(apiPatch).mockResolvedValue({ ...WORK, label: "work" });
    await save();
    expect(apiPatch).toHaveBeenCalledTimes(1);
  });

  it("goes back without a request when nothing changed", async () => {
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    await save();

    expect(apiPatch).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("an address the book no longer holds says so, with the way back", async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: "gone" });
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    expect(screen.getByText("This address isn't in your address book anymore.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Back to addresses" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("address-form-label")).toBeNull();
  });

  it("is a customer's: anyone else goes back to Account", async () => {
    jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    expect(mockRedirect.mock.calls[0][0]).toEqual({ href: "/account" });
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    await renderAddresses(<EditAddressScreen />, bookClient([HOME, WORK]));

    expect(screen.getByRole("header", { name: "Editar dirección" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Guardar dirección" })).toBeOnTheScreen();
  });
});
