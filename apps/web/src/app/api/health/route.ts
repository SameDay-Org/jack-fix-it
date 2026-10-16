// Railway healthcheck for the web service. Liveness only: it does not call the API.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" });
}
