/** Each still pose's standalone SVG stays under this (#404: < 30 KB minified). */
export const POSE_BUDGET_BYTES = 30 * 1024;

/**
 * An animated mascot as the runtime draws it in a page (the drawing plus its idle CSS) stays
 * under this (< 60 KB). There is no animated file (scripts/build.ts).
 */
export const ANIMATED_POSE_BUDGET_BYTES = 60 * 1024;
