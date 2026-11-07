import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Image, PixelRatio } from "react-native";

import "@/i18n";

import { IdCardSample } from "../IdCardSample";

jest.mock("expo-sensors");
jest.mock("react-native-view-shot");
jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);

const viewShot =
  jest.requireMock<typeof import("../../../../__mocks__/react-native-view-shot")>(
    "react-native-view-shot",
  );

beforeEach(() => {
  jest.spyOn(PixelRatio, "get").mockReturnValue(1);
  // getSize is overloaded (promise and callback forms), so the spy needs the promise form spelled out.
  jest
    .spyOn(Image, "getSize")
    .mockImplementation((() =>
      Promise.resolve({ width: 960, height: 606 })) as typeof Image.getSize);
  viewShot.captureRef.mockClear();
});

const renderSample = () =>
  render(
    <GestureHandlerRootView>
      <IdCardSample />
    </GestureHandlerRootView>,
  );

describe("IdCardSample", () => {
  it("shows both variants with sample people", async () => {
    await renderSample();
    await act(async () => undefined);

    expect(
      screen.getByRole("button", {
        name: "ID card, PRO, Alex Morgan, Fort Lauderdale, FL, (954) 555-0142",
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "ID card, María Pérez, Miami, FL, (305) 555-0199" }),
    ).toBeOnTheScreen();
    expect(screen.getByText("PRO")).toBeOnTheScreen();
  });

  it("types into the white card in place", async () => {
    await renderSample();
    await act(async () => undefined);

    await fireEvent.changeText(screen.getByLabelText("Name on the card"), "Lucía Gómez");

    expect(
      screen.getByRole("button", { name: "ID card, Lucía Gómez, Miami, FL, (305) 555-0199" }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: "ID card, María Pérez, Miami, FL, (305) 555-0199" }),
    ).toBeNull();
  });

  it("captures the share PNG and shows its pixel size", async () => {
    await renderSample();
    await act(async () => undefined);

    await fireEvent.press(screen.getByRole("button", { name: "Capture the share PNG" }));
    await fireEvent(
      screen.getByTestId("id-card-share-render-card-photo", { includeHiddenElements: true }),
      "loadEnd",
    );

    await waitFor(() =>
      expect(screen.getByTestId("id-card-share-size")).toHaveTextContent("960 x 606 px"),
    );
    // The preview shows the PNG the share render wrote into the app's private cache.
    expect(screen.getByTestId("id-card-share-preview").props.source).toEqual({
      uri: expect.stringMatching(/\/id-card-share\/card-.+\.png$/),
    });
  });
});
