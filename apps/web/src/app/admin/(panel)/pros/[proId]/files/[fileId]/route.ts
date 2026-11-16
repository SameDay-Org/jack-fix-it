import { ApiError, apiGet, apiTimeoutMs } from "@/lib/api";
import { staffAuth } from "@/lib/session";

import { isUuid } from "../../../../support/tickets";
import { PHOTO_FILE } from "../../../pros";

/**
 * A pro's document or profile photo, opened from the pro page (D7.4, #41). The page links
 * here instead of to the storage's short-lived signed address, so that address never reaches
 * the browser: not its history, not a new tab's address bar, not the page's HTML. Each opening
 * reads the pro through the API's audited detail (the staff member and the documents shown are
 * recorded), takes this file's signed address from it, fetches the file on the server and
 * passes it on, never cached.
 *
 * Only the types a pro may upload are passed on, inline, with no type sniffing; anything else
 * is refused. Nothing here logs, throws or answers the signed address: failures answer a fixed
 * status with no body.
 */

/** What a pro may upload as a document or a photo (apps/api uploads/keys.py), shown inline. */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

const NO_STORE = "no-store, private";

function fail(status: 404 | 502): Response {
  return new Response(null, { status, headers: { "Cache-Control": NO_STORE } });
}

type Params = { params: Promise<{ proId: string; fileId: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { proId, fileId } = await params;
  if (!isUuid(proId) || (fileId !== PHOTO_FILE && !isUuid(fileId))) return fail(404);
  // A staff session or a redirect (to the refresh or the end of the session), as for a page.
  const auth = await staffAuth();

  let signed: string | undefined;
  try {
    const pro = await apiGet("/v1/admin/pros/{pro_id}", {
      ...auth,
      params: { pro_id: proId },
      cache: "no-store",
    });
    signed =
      fileId === PHOTO_FILE
        ? pro.photo?.url
        : [...pro.documents, ...pro.history].find((document) => document.id === fileId)?.url;
  } catch (failure) {
    return fail(failure instanceof ApiError && failure.status === 404 ? 404 : 502);
  }
  if (!signed) return fail(404);

  let file: Response;
  try {
    file = await fetch(signed, { cache: "no-store", signal: AbortSignal.timeout(apiTimeoutMs()) });
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
