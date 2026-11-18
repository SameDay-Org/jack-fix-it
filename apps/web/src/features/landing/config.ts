/** The landing page's anchors: the header, the hero and the footer link to them. */
export const LANDING_ANCHORS = {
  top: "top",
  how: "how",
  services: "services",
  pros: "pros",
} as const;

/**
 * Whether the web request flow (#86) is live. Until it ships, the page shows no "What's going
 * on at home?" box and its call to action is "Get the app": nothing that does not work is
 * shown as if it worked. Off unless REQUEST_FLOW_ENABLED is exactly "true".
 */
export function requestFlowEnabled(): boolean {
  return process.env.REQUEST_FLOW_ENABLED === "true";
}

const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i;

/**
 * The address the footer's Contact link writes to: CONTACT_EMAIL, set in Railway. Unset or not
 * an address, there is no Contact link: the page never invents one.
 */
export function contactEmail(): string | null {
  const value = process.env.CONTACT_EMAIL?.trim();
  return value && EMAIL.test(value) ? value : null;
}
