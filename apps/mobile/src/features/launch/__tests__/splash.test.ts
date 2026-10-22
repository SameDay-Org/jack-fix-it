import * as SplashScreen from "expo-splash-screen";

import { liftSplash, resetSplashForTests } from "../splash";

jest.mock("expo-splash-screen", () => ({ hideAsync: jest.fn(async () => true) }));

describe("liftSplash", () => {
  beforeEach(() => {
    resetSplashForTests();
    jest.mocked(SplashScreen.hideAsync).mockClear();
  });

  it("hides the native splash once, however many paths ask", () => {
    liftSplash();
    liftSplash();
    liftSplash();
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  });
});
