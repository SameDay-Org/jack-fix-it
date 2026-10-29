import { DEFAULT_DATE_DAYS, readRequestConfig } from "../config";

describe("readRequestConfig", () => {
  it("offers 30 days unless EXPO_PUBLIC_REQUEST_DATE_DAYS says otherwise", () => {
    expect(readRequestConfig({ dateDays: undefined })).toStrictEqual({
      dateDays: DEFAULT_DATE_DAYS,
    });
    expect(DEFAULT_DATE_DAYS).toBe(30);
    expect(readRequestConfig({ dateDays: "14" })).toStrictEqual({ dateDays: 14 });
  });

  it.each(["0", "-3", "2.5", "a week"])("refuses %p", (dateDays) => {
    expect(() => readRequestConfig({ dateDays })).toThrow("EXPO_PUBLIC_REQUEST_DATE_DAYS");
  });
});
