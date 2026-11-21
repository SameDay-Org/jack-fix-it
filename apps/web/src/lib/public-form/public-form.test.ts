import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { emailInput } from "./email";
import { checkFormToken, mintFormToken } from "./form-token";
import { formTimings, requiredSecret } from "./settings";
import { forwardingHeaders, visitorIp } from "./visitor";

const SECRET = "form-secret-for-tests-0123456789abcdef";
const TIMINGS = { minSeconds: 3, maxAgeSeconds: 7200 };
const NOW = Date.parse("2026-11-19T12:00:00Z");
const at = (seconds: number) => NOW + seconds * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a public form's signed token", () => {
  it("goes once old enough, until it is too old, with a nonce made for it", () => {
    const token = mintFormToken(SECRET, "request", NOW);
    expect(checkFormToken(token, SECRET, "request", at(2), TIMINGS)).toEqual({
      ok: false,
      reason: "too_fast",
    });
    const ready = checkFormToken(token, SECRET, "request", at(3), TIMINGS);
    expect(ready.ok && ready.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkFormToken(token, SECRET, "request", at(7200), TIMINGS).ok).toBe(true);
    expect(checkFormToken(token, SECRET, "request", at(7201), TIMINGS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is refused by every other form", () => {
    const interest = mintFormToken(SECRET, "interest", NOW);
    expect(checkFormToken(interest, SECRET, "interest", at(10), TIMINGS).ok).toBe(true);
    expect(checkFormToken(interest, SECRET, "request", at(10), TIMINGS)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("gives each form its own nonce", () => {
    const nonce = (token: string) => {
      const check = checkFormToken(token, SECRET, "request", at(10), TIMINGS);
      return check.ok ? check.nonce : null;
    };
    expect(nonce(mintFormToken(SECRET, "request", NOW))).not.toBe(
      nonce(mintFormToken(SECRET, "request", NOW)),
    );
  });

  it("dates a fresh token back so it goes at once", () => {
    const fresh = mintFormToken(SECRET, "request", NOW, TIMINGS.minSeconds);
    expect(checkFormToken(fresh, SECRET, "request", NOW, TIMINGS).ok).toBe(true);
  });

  it("refuses a token another secret signed, or one changed in any part", () => {
    const token = mintFormToken(SECRET, "request", NOW);
    const [body, signature] = token.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const rewritten = Buffer.from(JSON.stringify({ ...payload, iat: payload.iat + 3600 })).toString(
      "base64url",
    );
    for (const probe of [
      mintFormToken("another-secret-0123456789abcdef0123", "request", NOW),
      `${rewritten}.${signature}`,
      `${body}.${signature.slice(0, -2)}AA`,
      `${body}.${signature}.extra`,
      `${body}.`,
      body,
      "",
      "x".repeat(600),
      42,
      null,
    ]) {
      expect(checkFormToken(probe, SECRET, "request", at(60), TIMINGS), String(probe)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("refuses a signed payload that is not the token's shape", () => {
    const forge = (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    };
    const iat = Math.floor(NOW / 1000) - 60;
    const nonce = "6b3c0e1d-1111-4222-8333-944455556666";
    for (const payload of [
      { v: 2, p: "request", iat, nonce },
      { v: 1, p: "other", iat, nonce },
      { v: 1, iat, nonce },
      { v: 1, p: "request", iat: "now", nonce },
      { v: 1, p: "request", iat, nonce: "not-a-uuid" },
      [1, iat],
      "token",
    ]) {
      expect(
        checkFormToken(forge(payload), SECRET, "request", NOW, TIMINGS),
        JSON.stringify(payload),
      ).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("visitorIp: the edge's address, never the client's", () => {
  it("reads only the configured header, and only its last value", () => {
    const request = new Headers({
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
      "x-real-ip": "198.51.100.1",
      "x-jfi-client-ip": "6.6.6.6",
    });
    expect(visitorIp(request, "x-forwarded-for")).toBe("203.0.113.7");
    expect(visitorIp(request, "x-real-ip")).toBe("198.51.100.1");
    expect(visitorIp(new Headers({ "x-forwarded-for": " 2001:db8::1 " }), "x-forwarded-for")).toBe(
      "2001:db8::1",
    );
  });

  it("forwards nothing without the setting, the header or a valid address", () => {
    const request = new Headers({ "x-forwarded-for": "203.0.113.7", "x-jfi-client-ip": "6.6.6.6" });
    vi.stubEnv("CLIENT_IP_HEADER", "");
    expect(visitorIp(request)).toBeNull();
    expect(visitorIp(request, "x-real-ip")).toBeNull();
    for (const value of ["", "unknown", "203.0.113.7, evil", "999.1.1.1", "203.0.113.7:443"]) {
      expect(
        visitorIp(new Headers({ "x-forwarded-for": value }), "x-forwarded-for"),
        value,
      ).toBeNull();
    }
  });

  it("puts the key and the address on the API call, never what the client sent", () => {
    vi.stubEnv("WEB_SERVICE_KEY", "web-service-key-for-tests-0123456789");
    vi.stubEnv("CLIENT_IP_HEADER", "x-forwarded-for");
    const headers = forwardingHeaders(
      new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7", "x-jfi-client-ip": "6.6.6.6" }),
    );
    expect([...headers.entries()]).toEqual([
      ["x-jfi-client-ip", "203.0.113.7"],
      ["x-jfi-web-key", "web-service-key-for-tests-0123456789"],
    ]);
    vi.stubEnv("WEB_SERVICE_KEY", "");
    vi.stubEnv("CLIENT_IP_HEADER", "");
    expect([...forwardingHeaders(new Headers({ "x-jfi-client-ip": "6.6.6.6" })).entries()]).toEqual(
      [],
    );
  });
});

describe("settings", () => {
  it("needs a secret of at least 32 characters", () => {
    vi.stubEnv("SOME_FORM_SECRET", "f".repeat(32));
    expect(requiredSecret("SOME_FORM_SECRET")).toBe("f".repeat(32));
    for (const value of ["", "f".repeat(31)]) {
      vi.stubEnv("SOME_FORM_SECRET", value);
      expect(() => requiredSecret("SOME_FORM_SECRET"), value).toThrow(/SOME_FORM_SECRET/);
    }
  });

  it("reads a form's timings, 3 seconds and 2 hours when unset or wrong", () => {
    vi.stubEnv("INTEREST_FORM_MIN_SECONDS", "");
    vi.stubEnv("INTEREST_FORM_MAX_AGE_SECONDS", "-5");
    expect(formTimings("INTEREST_FORM")).toEqual({ minSeconds: 3, maxAgeSeconds: 7200 });
    vi.stubEnv("REQUEST_FORM_MIN_SECONDS", "5");
    vi.stubEnv("REQUEST_FORM_MAX_AGE_SECONDS", "3600");
    expect(formTimings("REQUEST_FORM")).toEqual({ minSeconds: 5, maxAgeSeconds: 3600 });
  });
});

describe("emailInput", () => {
  it("trims and lowercases an address, and refuses what is not one", () => {
    expect(emailInput("  Ana.P@Example.COM ")).toBe("ana.p@example.com");
    for (const value of ["", "ana", "ana@", "@example.com", "ana@example", "a b@example.com", 42]) {
      expect(emailInput(value), String(value)).toBeNull();
    }
    expect(emailInput(`${"a".repeat(310)}@example.com`)).toBeNull();
  });
});
