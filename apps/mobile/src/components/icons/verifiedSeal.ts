/**
 * The verified seal (#230): a rosette with twelve soft scallops and a check cut out of its middle.
 * The check is a hole, not a second color: both subpaths share one path painted with the even-odd
 * rule, so whatever surface the seal sits on shows through the check, white card or navy.
 *
 * Drawn in a 24-unit view box, centered, inside a 1-unit margin:
 * - the rosette traces r = 10.3 + 0.7 cos 12θ around (12, 12), a scallop peak at the top (peaks at
 *   r 11, valleys at 9.6), as 24 cubic segments, one from each peak to the next valley;
 * - the check is the outline of a 2.8-unit stroke through (7.6, 12.3), (10.6, 15.2) and
 *   (16.4, 9.2) with round ends and a round outer corner, bold enough to read at 17 dp.
 */
export const VERIFIED_SEAL_VIEW_BOX = 24;

const ROSETTE =
  "M12 1C12.96 1 13.68 2.51 14.48 2.73C15.29 2.94 16.67 1.99 17.5 2.47C18.33 2.95 18.2 4.62 18.79 5.21C19.38 5.8 21.05 5.67 21.53 6.5C22.01 7.33 21.06 8.71 21.27 9.52C21.49 10.32 23 11.04 23 12C23 12.96 21.49 13.68 21.27 14.48C21.06 15.29 22.01 16.67 21.53 17.5C21.05 18.33 19.38 18.2 18.79 18.79C18.2 19.38 18.33 21.05 17.5 21.53C16.67 22.01 15.29 21.06 14.48 21.27C13.68 21.49 12.96 23 12 23C11.04 23 10.32 21.49 9.52 21.27C8.71 21.06 7.33 22.01 6.5 21.53C5.67 21.05 5.8 19.38 5.21 18.79C4.62 18.2 2.95 18.33 2.47 17.5C1.99 16.67 2.94 15.29 2.73 14.48C2.51 13.68 1 12.96 1 12C1 11.04 2.51 10.32 2.73 9.52C2.94 8.71 1.99 7.33 2.47 6.5C2.95 5.67 4.62 5.8 5.21 5.21C5.8 4.62 5.67 2.95 6.5 2.47C7.33 1.99 8.71 2.94 9.52 2.73C10.32 2.51 11.04 1 12 1Z";

const CHECK =
  "M6.63 13.31L9.63 16.21A1.4 1.4 0 0 0 11.61 16.17L17.41 10.17A1.4 1.4 0 0 0 17.37 8.19A1.4 1.4 0 0 0 15.39 8.23L10.57 13.22L8.57 11.29A1.4 1.4 0 0 0 6.59 11.33A1.4 1.4 0 0 0 6.63 13.31Z";

/** The rosette, then the check: paint it with `fillRule="evenodd"` or the check fills in. */
export const VERIFIED_SEAL_PATH = `${ROSETTE}${CHECK}`;
