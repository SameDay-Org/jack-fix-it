/**
 * The 3D phone's size, apart from phone-model.ts so that the page's own code (the CSS phone's
 * transform, choreography.ts) reads it without loading three.js.
 *
 * Units: the body is 1 wide. The screen keeps the 1:2 of the app's captures (media.ts), so a
 * capture fills it without being cut or stretched. The side buttons sit where the phone
 * drawn in CSS has them (phone-frame.tsx), so the two phones match when one replaces the
 * other.
 */
export const PHONE = {
  width: 1,
  height: 1.9,
  depth: 0.1,
  /** The corner radius of the body, seen from the front. */
  radius: 0.17,
  /** The rounded edge of the band. */
  bevel: 0.03,
  screen: { width: 0.9, height: 1.8, radius: 0.125 },
  /** The camera island, a pill below the screen's top edge. */
  island: { width: 0.27, height: 0.075, fromTop: 0.035 },
} as const;
