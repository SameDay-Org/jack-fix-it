/**
 * API calls against a real local server that never finishes answering (#158 round 1): every
 * call gives up within API_TIMEOUT_MS, body included, and sign-out never waits on it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bound, FakeCookieJar, MARKER } from "./test-helpers";

const { jar } = vi.hoisted(() => ({ jar: { current: null as unknown } }));

vi.mock("next/headers", () => ({ cookies: async () => jar.current }));
vi.mock("next/navigation", async () => {
  const { RedirectSignal: Signal } = await import("./test-helpers");
  return {
    redirect: (url: string) => {
      throw new Signal(url);
    },
  };
});

import { login } from "@/app/admin/login/actions";

import { apiGet } from "./api";
import {
  ACCESS_COOKIE,
  endSession,
  LOGIN_PATH,
  REFRESH_COOKIE,
  refreshStaffSession,
  requireStaff,
  SESSION_COOKIE,
} from "./session";

const DEADLINE_MS = 100;
// Far past the deadline, yet short: without a deadline the call would still be waiting.
const BOUND_MS = 20 * DEADLINE_MS;

let server: Server;
let cookies: FakeCookieJar;

/** Silent: accepts and never answers. Headers only: sends a 200 and a body that never ends. */
async function startApi(mode: "silent" | "headers-only"): Promise<string> {
  server = createServer((_, response) => {
    if (mode === "headers-only") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"id": ');
    }
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function within<T>(run: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await run().catch(() => undefined);
  return performance.now() - started;
}

beforeEach(() => {
  cookies = new FakeCookieJar();
  jar.current = cookies;
  vi.stubEnv("API_TIMEOUT_MS", String(DEADLINE_MS));
  vi.stubEnv("REFRESH_TOKEN_TTL_SECONDS", "604800");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

describe.each(["silent", "headers-only"] as const)("an API that is %s", (mode) => {
  beforeEach(async () => {
    vi.stubEnv("API_INTERNAL_URL", await startApi(mode));
  });

  it("apiGet gives up within the deadline", async () => {
    await expect(apiGet("/health")).rejects.toThrow();
    expect(await within(() => apiGet("/health"))).toBeLessThan(BOUND_MS);
  });

  it("login fails as unavailable within the deadline", async () => {
    const form = new FormData();
    form.set("email", "staff@example.com");
    form.set("password", "a-password");
    let state: unknown;

    const elapsed = await within(async () => {
      state = await login({ error: null, email: "" }, form);
    });

    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(state).toEqual({ error: "unavailable", email: "staff@example.com" });
  });

  it("a refresh gives up within the deadline", async () => {
    cookies.reset({ [REFRESH_COOKIE]: bound("rt-1"), [SESSION_COOKIE]: MARKER });
    let next: unknown;

    const elapsed = await within(async () => {
      next = await refreshStaffSession();
    });

    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(next).toBe(LOGIN_PATH);
  });

  it("the /me check gives up within the deadline", async () => {
    cookies.reset({
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
      [SESSION_COOKIE]: MARKER,
    });

    expect(await within(() => requireStaff())).toBeLessThan(BOUND_MS);
  });

  it("logout clears every cookie however the revoke ends", async () => {
    cookies.reset({
      [ACCESS_COOKIE]: bound("at-1"),
      [REFRESH_COOKIE]: bound("rt-1"),
      [SESSION_COOKIE]: MARKER,
    });

    expect(await within(endSession)).toBeLessThan(BOUND_MS);
    expect(cookies.values.size).toBe(0);
  });
});
