import * as Notifications from "expo-notifications";

import { receivePushTap } from "./pushTaps";

// The notifications already handed over, by id: a push that launched the app can reach both the
// launch read and the listener.
const handled = new Set<string>();

function handle(response: Notifications.NotificationResponse): void {
  // A tap on the notification itself; a dismissal or another action opens nothing.
  if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const { identifier, content } = response.notification.request;
  if (handled.has(identifier)) return;
  handled.add(identifier);
  // Only the url is read: what the app opens is decided later, from an allow-list.
  receivePushTap(content.data?.url);
}

/**
 * Hands every tapped push to the app (`useOpenPushTaps` opens it): the tap that launched the app
 * (a cold start), then each tap while it runs (warm). Called once at app start, before the session
 * is known; the launch tap is cleared once read, so a reload or a later sign-in never reads it
 * again. Returns the unsubscribe.
 */
export function listenForPushTaps(): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  const launch = Notifications.getLastNotificationResponse();
  if (launch) {
    Notifications.clearLastNotificationResponse();
    handle(launch);
  }
  return () => subscription.remove();
}
