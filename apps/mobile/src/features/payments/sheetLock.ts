// Stripe shows one sheet at a time, whichever card or flow asks: paying for a quote, or saving a
// card in the wallet (#253).
let inUse = false;

/**
 * Takes the app's one Stripe sheet for a flow, from the tap until the sheet has closed. Returns
 * what gives it back (call it once, in a `finally`), or null while another flow is preparing or
 * showing a sheet: that second ask is ignored.
 */
export function claimSheet(): (() => void) | null {
  if (inUse) return null;
  inUse = true;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    inUse = false;
  };
}
