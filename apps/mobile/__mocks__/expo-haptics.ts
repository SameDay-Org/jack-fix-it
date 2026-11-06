// Manual Jest mock, applied to every suite (root __mocks__): the real enums, the native calls as
// resolved jest.fn so a test asserts the call and nothing vibrates.
import type * as HapticsModule from "expo-haptics";

const actual = jest.requireActual<typeof HapticsModule>("expo-haptics");

export const { AndroidHaptics, ImpactFeedbackStyle, NotificationFeedbackType } = actual;

export const impactAsync = jest.fn(
  async (_style?: HapticsModule.ImpactFeedbackStyle): Promise<void> => undefined,
);
export const notificationAsync = jest.fn(
  async (_type?: HapticsModule.NotificationFeedbackType): Promise<void> => undefined,
);
export const selectionAsync = jest.fn(async (): Promise<void> => undefined);
export const performAndroidHapticsAsync = jest.fn(
  async (_type: HapticsModule.AndroidHaptics): Promise<void> => undefined,
);
