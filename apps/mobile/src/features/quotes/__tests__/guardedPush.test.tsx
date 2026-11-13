import { act, fireEvent, renderRouter } from "expo-router/testing-library";
import { Pressable, Text } from "react-native";

import { useGuardedPush } from "../navigation";

// A screen that opens another one through the guarded push, as the job banner and the quote
// cards do.
function Start() {
  const push = useGuardedPush();
  return (
    <Pressable accessibilityRole="button" onPress={() => push("/help")}>
      <Text>Open help</Text>
    </Pressable>
  );
}

const ROUTES = { index: Start, help: () => <Text>Help screen</Text> };

// What Expo Router logs while two roots are mounted at once: expected here, nothing else is.
const TWO_ROOTS = /linking in multiple places|multiple navigation containers/;

describe("useGuardedPush when Android re-creates the app (#344)", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    const original = console.error.bind(console);
    consoleError = jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (!TWO_ROOTS.test(String(args[0]))) original(...args);
    });
  });

  afterEach(() => consoleError.mockRestore());

  it("still opens the next screen after the previous root unmounts", async () => {
    // A system font-size change re-creates the activity: the JS runtime survives, a new root
    // mounts and the old one unmounts. The old root's teardown resets Expo Router's module-level
    // `router`, so a press on the new root must not depend on it.
    const previous = await renderRouter(ROUTES);
    const current = await renderRouter(ROUTES);
    await previous.unmount();

    await fireEvent.press(current.getByRole("button", { name: "Open help" }));
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    expect(current.getByText("Help screen")).toBeTruthy();
  });
});
