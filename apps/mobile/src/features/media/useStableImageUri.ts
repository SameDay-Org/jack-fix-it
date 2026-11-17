import { useState } from "react";

/** A URL this close to its expiry counts as expired: the image would start loading as it runs out. */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * The URL to draw a stored picture from. Every answer carries a new signed URL for the same
 * picture: the one the component mounted with is kept while it still works, so the picture is
 * not loaded twice. A different picture is a different component (key it by the picture's id).
 */
export function useStableImageUri(
  image: { url: string; expires_at: string } | null | undefined,
): string | undefined {
  const [first] = useState(() =>
    image && Date.parse(image.expires_at) - EXPIRY_MARGIN_MS > Date.now() ? image.url : undefined,
  );
  return first ?? image?.url;
}
