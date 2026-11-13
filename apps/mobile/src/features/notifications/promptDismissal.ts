import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

// The storage alone, not the session barrel: screens that mock `@/api` still draw the card.
import { notificationsPromptStorage } from "@/api/tokenStorage";

import { reportFailure } from "./report";

// `null` until read from the device: the pre-prompt waits for it rather than flash.
const dismissalStore = createStore<{ dismissed: boolean | null }>()(() => ({ dismissed: null }));
let reading: Promise<void> | null = null;

function readOnce(): void {
  reading ??= notificationsPromptStorage.readDismissed().then((dismissed) => {
    if (dismissalStore.getState().dismissed === null) dismissalStore.setState({ dismissed });
  });
}

/** Whether the person closed the pre-prompt on this device; `null` while reading. */
export function usePromptDismissed(): boolean | null {
  useEffect(readOnce, []);
  return useStore(dismissalStore, (state) => state.dismissed);
}

/** Closes the pre-prompt for good on this device. Memory first; the write is best effort. */
export function dismissPrompt(): void {
  dismissalStore.setState({ dismissed: true });
  notificationsPromptStorage
    .writeDismissed()
    .catch((error: unknown) => reportFailure("Notification prompt state write failed", error));
}

/** Forgets the state. Tests only. */
export function resetPromptDismissalForTests(): void {
  dismissalStore.setState({ dismissed: null });
  reading = null;
}
