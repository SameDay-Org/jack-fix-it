import {
  DEFAULT_PASSWORD_MIN_LENGTH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UPLOAD_MIN_BYTES_PER_SECOND,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  readApiConfig,
} from "../config";

jest.mock("../config", () => {
  // The module reads the environment at import time; tests exercise the pure reader instead.
  process.env.EXPO_PUBLIC_API_URL = "https://api.test.invalid";
  return jest.requireActual("../config");
});

const https = "https://api.jackfixit.test";
const http = "http://10.0.2.2:8000";

describe("readApiConfig", () => {
  it("accepts https anywhere", () => {
    expect(readApiConfig({ url: https, timeoutMs: undefined, dev: false }).baseUrl.origin).toBe(
      https,
    );
  });

  it("rejects http outside dev", () => {
    expect(() => readApiConfig({ url: http, timeoutMs: undefined, dev: false })).toThrow(
      /https:\/\/ outside development/,
    );
  });

  it("allows http in dev", () => {
    expect(readApiConfig({ url: http, timeoutMs: undefined, dev: true }).baseUrl.origin).toBe(http);
  });

  it("requires the URL and rejects a malformed one", () => {
    expect(() => readApiConfig({ url: undefined, timeoutMs: undefined, dev: true })).toThrow(
      /EXPO_PUBLIC_API_URL is not set/,
    );
    expect(() => readApiConfig({ url: "not a url", timeoutMs: undefined, dev: true })).toThrow(
      /not a valid URL/,
    );
  });

  it("defaults the timeout and rejects a bad one", () => {
    expect(readApiConfig({ url: https, timeoutMs: undefined, dev: false }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
    expect(readApiConfig({ url: https, timeoutMs: "", dev: false }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
    expect(readApiConfig({ url: https, timeoutMs: "8000", dev: false }).timeoutMs).toBe(8000);
    expect(() => readApiConfig({ url: https, timeoutMs: "soon", dev: false })).toThrow(
      /EXPO_PUBLIC_API_TIMEOUT_MS/,
    );
    expect(() => readApiConfig({ url: https, timeoutMs: "0", dev: false })).toThrow(
      /EXPO_PUBLIC_API_TIMEOUT_MS/,
    );
  });

  it("defaults the upload timeout and rejects a bad one", () => {
    const base = { url: https, timeoutMs: undefined, dev: false };
    expect(readApiConfig(base).uploadTimeoutMs).toBe(DEFAULT_UPLOAD_TIMEOUT_MS);
    expect(readApiConfig({ ...base, uploadTimeoutMs: "60000" }).uploadTimeoutMs).toBe(60_000);
    expect(() => readApiConfig({ ...base, uploadTimeoutMs: "-1" })).toThrow(
      /EXPO_PUBLIC_UPLOAD_TIMEOUT_MS/,
    );
    expect(readApiConfig(base).uploadMinBytesPerSecond).toBe(DEFAULT_UPLOAD_MIN_BYTES_PER_SECOND);
    expect(
      readApiConfig({ ...base, uploadMinBytesPerSecond: "65536" }).uploadMinBytesPerSecond,
    ).toBe(65_536);
    expect(() => readApiConfig({ ...base, uploadMinBytesPerSecond: "fast" })).toThrow(
      /EXPO_PUBLIC_UPLOAD_MIN_BYTES_PER_SECOND/,
    );
  });

  it("defaults the password minimum and rejects a bad one", () => {
    const base = { url: https, timeoutMs: undefined, dev: false };
    expect(readApiConfig(base).passwordMinLength).toBe(DEFAULT_PASSWORD_MIN_LENGTH);
    expect(readApiConfig({ ...base, passwordMinLength: "12" }).passwordMinLength).toBe(12);
    expect(() => readApiConfig({ ...base, passwordMinLength: "ten" })).toThrow(
      /EXPO_PUBLIC_PASSWORD_MIN_LENGTH/,
    );
    expect(() => readApiConfig({ ...base, passwordMinLength: "0" })).toThrow(
      /EXPO_PUBLIC_PASSWORD_MIN_LENGTH/,
    );
  });
});
