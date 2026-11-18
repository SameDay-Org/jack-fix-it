/** Each still pose's standalone SVG stays under this (#404: < 30 KB minified). */
export const POSE_BUDGET_BYTES = 30 * 1024;

/** Each animated pose (the still drawing plus its idle CSS) stays under this (< 60 KB). */
export const ANIMATED_POSE_BUDGET_BYTES = 60 * 1024;
