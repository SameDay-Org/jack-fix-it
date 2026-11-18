import { ApiError, apiGet, apiTimeoutMs } from "@/lib/api";
import { staffAuth } from "@/lib/session";

import { isUuid } from "../../../../support/tickets";

/**
 * One photo of a dispute, shown on the dispute's page (#83). The page points here instead of
 * at the storage's short-lived signed address of the photo's safe copy, so that address never
 * reaches the browser: not its history, not a new tab's address bar, not the page's HTML. Each
 * opening reads the dispute through the API's audited detail (the staff member and the dispute
 * are recorded), takes this photo's signed address from it, fetches the file on the server and
 * passes it on, never cached.
 *
 * Only the image types a customer may upload for a dispute are passed on, inline, with no type
 * sniffing; anything else is refused. Nothing here logs, throws or answers the signed address:
 * failures answer a fixed status with no body.
 */

/** What a customer may upload as a dispute photo (apps/api uploads/keys.py), shown inline. */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

const NO_STORE = "no-store";

function fail(status: 404 | 502): Response {
  return new Response(null, { status, headers: { "Cache-Control": NO_STORE } });
}

type Params = { params: Promise<{ disputeId: string; photoId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { disputeId, photoId } = await params;
  if (!isUuid(disputeId) || !isUuid(photoId)) return fail(404);
  // A staff session or a redirect (to the refresh or the end of the session), as for a page.
  const auth = await staffAuth();

  let signed: string | undefined;
  try {
    const dispute = await apiGet("/v1/admin/disputes/{dispute_id}", {
      ...auth,
      params: { dispute_id: disputeId },
      cache: "no-store",
    });
    signed = dispute.photos.find((photo) => photo.id === photoId)?.url;
  } catch (failure) {
    return fail(failure instanceof ApiError && failure.status === 404 ? 404 : 502);
  }
  if (!signed) return fail(404);

  let file: Response;
  try {
    file = await fetch(signed, {
      cache: "no-store",
      // Only the address the API just gave: a redirect from the storage is refused before
      // anything else is asked (it would lead the server to another host).
      redirect: "error",
      signal: AbortSignal.timeout(apiTimeoutMs()),
    });
  } catch {
    return fail(502); // the error may carry the address: it goes no further
  }
  const type = file.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!file.ok || !file.body || !INLINE_TYPES.has(type)) {
    await file.body?.cancel();
    return fail(502);
  }
  const headers = new Headers({
    "Content-Type": type,
    "Content-Disposition": "inline",
    "Cache-Control": NO_STORE,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  const length = file.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(file.body, { status: 200, headers });
}
