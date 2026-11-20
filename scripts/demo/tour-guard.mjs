// The web tour's host guard: the browser reaches the network only through a proxy this
// script runs, and the proxy connects to the allowed hosts and to nothing else.
//
// Why a proxy and not a Playwright route: a route sees the first request of a redirect chain
// only (Chromium continues every redirected request without asking it), so an allowed page
// answering 307 could forward a form's body to any host before a check could run. At the
// proxy every connection the browser makes is asked for by name first: each hop of a redirect,
// a subresource, an iframe, a fetch, a websocket, a service worker. A host that is not allowed
// gets no connection at all: not a request, not a TCP handshake.
//
// Three things go around a proxy, and each is closed here:
// - loopback: Chromium skips a proxy for localhost and 127.0.0.0/8 unless told otherwise;
// - WebRTC: STUN and ICE send UDP straight to any address a page names. The switch that stops
//   it is passed at launch (Edge ignores the older `--force-` spelling), and every frame of a
//   guarded context loses the WebRTC constructors before its scripts run;
// - Node's own proxy settings: the guard's upstream requests use an agent of their own, so
//   NODE_USE_ENV_PROXY and HTTP_PROXY never send the tour's traffic to another host.
//
// A name is not an address. The guard never lets a resolver decide where an allowed name goes:
// `localhost` connects to 127.0.0.1 or ::1, from a table, whatever a hosts file or a resolver
// would answer; the one other host (staging) is resolved once, before the guard serves anything,
// every address it has is checked (never loopback, private, link-local or cloud metadata, unless
// DEMO_STAGING_ALLOW_PRIVATE=1 allows the private ones), and its connections go to those
// addresses only: a later answer that changed (DNS rebinding) is never asked for. Plain http and
// tunnels connect the same way.
//
// Every socket and stream has an error listener, and every way an upstream answer can fail
// ends that one browser request with a 502: a hostile or broken server stops a request, never
// the tour.
import dns from "node:dns";
import http from "node:http";
import net from "node:net";

/** `[::1]` as `::1`, and lower case: the one form hostnames are compared in. */
export const bare = (hostname) =>
  String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

/** The hosts the tour may reach: this machine, and one named staging host. */
export function allowedHosts(stagingHost) {
  return new Set(["localhost", "127.0.0.1", stagingHost].filter(Boolean).map(bare));
}

/** Whether `hostname` (as a URL writes it, brackets and case included) is an allowed one. */
export const permits = (allowed, hostname) => allowed.has(bare(hostname));

/**
 * Whether the page at `url` is somewhere the tour must not be: any web address on a host that
 * is not allowed, and any address that is not a web one (a file, data or blob URL, a browser
 * error page) but the empty `about:blank`. A URL Node cannot parse counts as elsewhere: the
 * check fails closed, never throws.
 */
export function isElsewhere(url, allowed) {
  if (url === "about:blank") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return !permits(allowed, parsed.hostname);
}

/** A URL's host for a report, whatever it is: its hostname, or the raw text when Node cannot
 * parse it. */
export function hostOf(url) {
  try {
    return bare(new URL(url).hostname) || url;
  } catch {
    return url;
  }
}

/**
 * The host and port a CONNECT asks for, from its authority (`host:port`, `[v6]:port`); null
 * when the port is missing, zero or not a port. The port is read from the text: a URL parser
 * would drop :80 as http's default.
 */
export function tunnelTarget(authority) {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(String(authority));
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: bare(match[1]), port };
}

// The loopback hosts, with the only addresses they connect to: no resolver is asked for them.
const LOOPBACK = new Map([
  [
    "localhost",
    [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ],
  ],
  ["127.0.0.1", [{ address: "127.0.0.1", family: 4 }]],
  ["::1", [{ address: "::1", family: 6 }]],
]);

const blockList = (ranges) => {
  const list = new net.BlockList();
  for (const [address, prefix, family] of ranges) list.addSubnet(address, prefix, family);
  return list;
};
// Where the staging host may never point: link-local (cloud metadata at 169.254.169.254 and
// fd00:ec2::254 included), unspecified, multicast and reserved addresses, NAT64's prefix (it
// embeds any IPv4 address). IPv4-mapped IPv6 addresses are checked as the IPv4 they carry.
const NEVER = blockList([
  ["0.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["100.100.100.200", 32, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["fd00:ec2::254", 128, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
]);
// And where only DEMO_STAGING_ALLOW_PRIVATE=1 lets it point: this machine and private networks.
const PRIVATE = blockList([
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
]);

/** Why the staging host may not have `address`, or null when it may. */
function blocked(address, allowPrivate) {
  const family = net.isIP(address);
  if (family === 0) return "not an IP address";
  // A zone (fe80::1%eth0) names an interface: a staging host's address never needs one, so
  // any is refused, on whatever address (the block list reads past it, and only catches it
  // on a link-local one).
  if (address.includes("%")) return "a zone-scoped address";
  const kind = family === 6 ? "ipv6" : "ipv4";
  try {
    if (NEVER.check(address, kind)) return "link-local, metadata or not unicast";
    if (!allowPrivate && PRIVATE.check(address, kind)) {
      return "loopback or private; DEMO_STAGING_ALLOW_PRIVATE=1 allows it";
    }
  } catch {
    return "not an address the guard can check";
  }
  return null;
}

const systemResolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Every allowed host's addresses, fixed before the guard serves anything: the loopback hosts'
 * from the table above; any other host (the staging one) an address as written, or resolved
 * once with `resolve`, and EVERY address it has checked. A host with an address it may not
 * have, or none, stops the guard from starting.
 */
async function pinAddresses(allowed, { allowPrivate = false, resolve = systemResolve }) {
  const pinned = new Map();
  for (const host of allowed) {
    if (LOOPBACK.has(host)) {
      pinned.set(host, LOOPBACK.get(host));
      continue;
    }
    const literal = net.isIP(host);
    const answer = literal ? [{ address: host, family: literal }] : await resolve(host);
    const addresses = answer.map(({ address, family }) => ({ address, family }));
    if (addresses.length === 0) throw new Error(`the tour's host guard: ${host} has no address`);
    for (const { address } of addresses) {
      const reason = blocked(address, allowPrivate);
      if (reason !== null) {
        throw new Error(
          `the tour's host guard refuses ${host}: it resolves to ${address} (${reason})`,
        );
      }
    }
    pinned.set(host, addresses);
  }
  return pinned;
}

/**
 * A `lookup` for net and http that answers from `pinned` alone: a name connects to the
 * addresses fixed for it at the start, and no resolver is ever asked. Any other name has none.
 */
const pinnedLookup = (pinned) => (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const wanted = typeof options === "object" && options !== null ? options : {};
  const family = { 4: 4, 6: 6, IPv4: 4, IPv6: 6 }[wanted.family] ?? 0;
  const addresses = (pinned.get(bare(hostname)) ?? []).filter(
    (entry) => family === 0 || entry.family === family,
  );
  if (addresses.length === 0) {
    const error = new Error(`the demo tour's host guard has no address for ${hostname}`);
    error.code = "ENOTFOUND";
    process.nextTick(done, error);
  } else if (wanted.all) {
    process.nextTick(done, null, addresses);
  } else {
    process.nextTick(done, null, addresses[0].address, addresses[0].family);
  }
};

// What a proxy must not pass on: they are about the hop to the proxy itself.
const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization"]);

/**
 * Starts the guard: a forward proxy on a loopback port that serves the hosts in `allowed` and
 * refuses every other one (403, nothing connected). Each allowed host connects only to the
 * addresses pinned for it at the start (pinAddresses): `options.allowPrivate` lets the staging
 * host be on a private network, `options.resolve` replaces the system resolver (tests). Rejects
 * when the staging host may not be reached. `refused` collects the refused hosts, in order, for
 * the caller to report.
 */
export async function startGuard(allowed, options = {}) {
  const lookup = pinnedLookup(await pinAddresses(allowed, options));
  const refused = [];
  const refuse = (hostname) => refused.push(bare(hostname));
  // Its own agent: the process-wide one follows NODE_USE_ENV_PROXY and HTTP_PROXY.
  const agent = new http.Agent({ keepAlive: true });
  // The tunnels (CONNECT) leave the HTTP server's hands: closing the guard ends them too.
  const tunnels = new Set();
  const ignore = () => {};

  // Plain http: the browser sends the whole URL (GET http://host:port/path).
  const server = http.createServer((request, response) => {
    request.on("error", ignore);
    response.on("error", ignore);
    /** Ends the browser's request with `status`, once, whatever state it is in. */
    const fail = (status, reason) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      try {
        response.writeHead(status, reason, { "content-type": "text/plain" });
        response.end(`${reason} (the demo tour's host guard)`);
      } catch {
        response.destroy();
      }
    };
    let target;
    try {
      target = new URL(request.url);
    } catch {
      fail(400, "Bad Request");
      return;
    }
    if (target.protocol !== "http:" || !permits(allowed, target.hostname)) {
      refuse(target.hostname);
      response.writeHead(403, "Forbidden", { "content-type": "text/plain" });
      response.end("Refused by the demo tour's host guard.");
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name)),
    );
    const upstream = http.request(
      {
        agent,
        host: bare(target.hostname),
        lookup,
        port: target.port || 80,
        method: request.method,
        path: target.pathname + target.search,
        headers,
      },
      (answer) => {
        answer.on("error", () => response.destroy());
        try {
          response.writeHead(answer.statusCode, answer.statusMessage, answer.rawHeaders);
        } catch {
          // A status line or header Node's server refuses to write (a control character, a
          // status below 100): the browser gets a 502 instead.
          answer.destroy();
          fail(502, "Bad Gateway");
          return;
        }
        answer.pipe(response);
      },
    );
    upstream.on("error", () => fail(502, "Bad Gateway"));
    // Closed before any answer reached the browser (no response, no error: a 101 to a plain
    // request is one, Node drops its socket): end its request. Once an answer has started,
    // its own end or error ends the browser's.
    upstream.on("close", () => {
      if (!response.headersSent) fail(502, "Bad Gateway");
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  // https and websockets: the browser asks for a tunnel to host:port (CONNECT).
  server.on("connect", (request, socket, head) => {
    socket.on("error", ignore);
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    const target = tunnelTarget(request.url);
    if (target === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!permits(allowed, target.host)) {
      refuse(target.host);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({ port: target.port, host: target.host, lookup }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.on("close", () => tunnels.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  // An upgrade sent to the proxy itself is not a tunnel request: nothing to serve.
  server.on("upgrade", (_request, socket) => {
    socket.on("error", ignore);
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    refused,
    close: () =>
      new Promise((resolve) => {
        for (const socket of tunnels) socket.destroy();
        agent.destroy();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// WebRTC's constructors, removed from every frame of a guarded context before its scripts run.
// The tour's pages have no use for them; the launch switch below is the other layer.
const NO_WEBRTC = () => {
  for (const name of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "RTCDataChannel",
    "RTCIceCandidate",
    "RTCIceTransport",
    "RTCRtpSender",
    "RTCRtpReceiver",
    "RTCRtpTransceiver",
    "RTCSessionDescription",
    "RTCDtlsTransport",
    "RTCSctpTransport",
  ]) {
    try {
      delete globalThis[name];
    } catch {
      // A name the browser does not define.
    }
  }
};

/** Sets up a context of the guarded browser: no WebRTC in any of its frames. */
export async function guardContext(context) {
  await context.addInitScript(NO_WEBRTC);
  return context;
}

/**
 * Launches the browser behind `guard`: every request goes through it, loopback included.
 * `chromium` is playwright-core's; the other options are the caller's.
 */
export function launchGuarded(chromium, guard, options) {
  return chromium.launch({
    ...options,
    // "<-loopback>" removes Chromium's built-in rule that localhost and 127.0.0.0/8 skip the
    // proxy: without it another loopback address (127.0.0.2) would be reached directly.
    proxy: { server: guard.url, bypass: "<-loopback>" },
    // WebRTC sends no UDP but through the proxy, which takes none: no STUN, no ICE checks.
    // Edge honours this spelling and ignores the older `--force-` one, kept for Chrome.
    args: [
      ...(options.args ?? []),
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
}
