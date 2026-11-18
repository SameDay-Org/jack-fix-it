/**
 * `pnpm --filter @jack/mascot preview`: serves the gallery (gallery.ts) on 127.0.0.1, on a free
 * port unless PORT is set, and prints its address. Local only: nothing here is part of the site.
 */
import { createServer } from "node:http";

import { galleryHtml } from "./gallery.ts";

const server = createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    })
    .end(galleryHtml());
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : process.env.PORT;
  console.log(`Mascot gallery: http://127.0.0.1:${port}/`);
});
