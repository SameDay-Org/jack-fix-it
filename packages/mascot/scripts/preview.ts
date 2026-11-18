/**
 * `pnpm --filter @jack/mascot preview`: serves the gallery on 127.0.0.1 (serve.ts), on a free
 * port unless PORT is set, and prints its address. Local only: nothing here is part of the site.
 */
import { createServer } from "node:http";

import { HEADERS, respond } from "./serve.ts";

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const answer = respond(path);
  response.writeHead(answer.status, { ...HEADERS, "Content-Type": answer.type }).end(answer.body);
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : process.env.PORT;
  console.log(`Mascot gallery: http://127.0.0.1:${port}/`);
});
