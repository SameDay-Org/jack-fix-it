import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { tokens } from "@/theme";

export type ToastTone = "neutral" | "success" | "danger";

export type Toast = {
  /** Distinguishes two toasts with the same text, so a replaced toast's timer cannot hide the new one. */
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastState = { current: Toast | null };

export const toastStore = createStore<ToastState>()(() => ({ current: null }));

let nextId = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
}

/** Shows one toast at a time: a new one replaces the current one and its timer starts over. */
export function showToast({ message, tone }: { message: string; tone: ToastTone }): void {
  clearHideTimer();
  const toast: Toast = { id: ++nextId, message, tone };
  toastStore.setState({ current: toast });
  hideTimer = setTimeout(() => dismissToast(toast.id), tokens.motion.toastMs);
}

/** Hides the current toast; with an `id`, only if that toast is still the one showing. */
export function dismissToast(id?: number): void {
  const { current } = toastStore.getState();
  if (current === null || (id !== undefined && current.id !== id)) return;
  clearHideTimer();
  toastStore.setState({ current: null });
}

/** The toast on screen, for the host that renders it. */
export function useToast(): Toast | null {
  return useStore(toastStore, (state) => state.current);
}
