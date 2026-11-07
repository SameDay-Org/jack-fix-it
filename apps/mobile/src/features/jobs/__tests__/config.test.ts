import { DEFAULT_ETA_CLOSE_MINUTES, DEFAULT_POLL_SECONDS, readJobsConfig } from "../config";

describe("readJobsConfig", () => {
  it("defaults to a 15 s poll and a 60 min countdown window", () => {
    expect(DEFAULT_POLL_SECONDS).toBe(15);
    expect(DEFAULT_ETA_CLOSE_MINUTES).toBe(60);
    expect(readJobsConfig({ pollSeconds: undefined, etaCloseMinutes: undefined })).toEqual({
      pollMs: 15_000,
      etaCloseMinutes: 60,
    });
  });

  it("an empty value counts as unset", () => {
    expect(readJobsConfig({ pollSeconds: "", etaCloseMinutes: "" })).toEqual({
      pollMs: 15_000,
      etaCloseMinutes: 60,
    });
  });

  it("takes valid overrides, the poll in seconds turned into milliseconds", () => {
    expect(readJobsConfig({ pollSeconds: "30", etaCloseMinutes: "45" })).toEqual({
      pollMs: 30_000,
      etaCloseMinutes: 45,
    });
    expect(readJobsConfig({ pollSeconds: "1", etaCloseMinutes: undefined })).toEqual({
      pollMs: 1_000,
      etaCloseMinutes: 60,
    });
  });

  it.each(["0", "-5", "2.5", "abc", "15s"])("refuses a poll of %j", (pollSeconds) => {
    expect(() => readJobsConfig({ pollSeconds, etaCloseMinutes: undefined })).toThrow(
      "EXPO_PUBLIC_JOB_POLL_SECONDS must be a positive whole number",
    );
  });

  it.each(["0", "-1", "0.5", "soon"])("refuses a countdown window of %j", (etaCloseMinutes) => {
    expect(() => readJobsConfig({ pollSeconds: undefined, etaCloseMinutes })).toThrow(
      "EXPO_PUBLIC_JOB_ETA_CLOSE_MINUTES must be a positive whole number",
    );
  });
});
