import { ApiError, apiGet, apiTimeoutMs } from "@/lib/api";
import { staffAuth } from "@/lib/session";

import { isUuid, type RequestCard } from "../../../../queue/queue";

/**
 * One photo or video of a request, opened from the request card (#81). The card links here
 * instead of to the storage's short-lived signed address, so that address never reaches the
 * browser: not its history, not a new tab's address bar, not the page's HTML. Each opening
 * reads the request through the API's audited card (the staff member and the request are
 * recorded), takes the media at this position of that card, fetches it on the server and
 * passes it on, never cached. A position only ever names a media of the request in the path.
 *
 * Only the types a customer may upload for that kind of media are passed on, inline, with no
 * type sniffing; anything else is refused. Nothing here logs, throws or answers the signed
 * address: failures answer a fixed status with no body.
 */

type Media = RequestCard["media"][number];

/** What a customer may upload as a request's photo or video (apps/api uploads/keys.py). */
const INLINE_TYPES: Record<Media["kind"], ReadonlySet<string>> = {
  photo: new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]),
  video: new Set(["video/mp4", "video/quicktime"]),
};

/** The media's position in the card: a plain number, no sign, no leading zero. */
const POSITION = /^(0|[1-9][0-9]{0,2})$/;

const NO_STORE = "no-store";

function fail(status: 404 | 502): Response {
  return new Response(null, { status, headers: { "Cache-Control": NO_STORE } });
}

type Params = { params: Promise<{ requestId: string; index: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { requestId, index } = await params;
  if (!isUuid(requestId) || !POSITION.test(index)) return fail(404);
  // A staff session or a redirect (to the refresh or the end of the session), as for a page.
  const auth = await staffAuth();

  let media: Media | undefined;
  try {
    const card = await apiGet("/v1/admin/requests/{request_id}", {
      ...auth,
      params: { request_id: requestId },
    });
    media = card.media[Number(index)];
  } catch (failure) {
    return fail(failure instanceof ApiError && failure.status === 404 ? 404 : 502);
  }
  if (!media) return fail(404);

  let file: Response;
  try {
    file = await fetch(media.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(apiTimeoutMs()),
    });
  } catch {
    return fail(502); // the error may carry the address: it goes no further
  }
  const type = file.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowed = Object.hasOwn(INLINE_TYPES, media.kind) && INLINE_TYPES[media.kind].has(type);
  if (!file.ok || !file.body || !allowed) {
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
