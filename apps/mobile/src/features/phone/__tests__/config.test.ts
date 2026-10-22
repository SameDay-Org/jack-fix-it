import { DEFAULT_COUNTRY_CODE, DEFAULT_RESEND_SECONDS, readPhoneConfig } from "../config";

describe("readPhoneConfig", () => {
  it("defaults to +1 and the resend wait when nothing is set", () => {
    expect(readPhoneConfig({ countryCode: undefined, resendSeconds: undefined })).toEqual({
      countryCode: DEFAULT_COUNTRY_CODE,
      resendSeconds: DEFAULT_RESEND_SECONDS,
    });
    expect(DEFAULT_COUNTRY_CODE).toBe("+1");
    expect(DEFAULT_RESEND_SECONDS).toBe(30);
  });

  it("reads both values from the environment", () => {
    expect(readPhoneConfig({ countryCode: "+1", resendSeconds: "45" })).toEqual({
      countryCode: "+1",
      resendSeconds: 45,
    });
  });

  it("refuses a calling code that is not one", () => {
    for (const countryCode of ["1", "+0", "+1234", "+1a"]) {
      expect(() => readPhoneConfig({ countryCode, resendSeconds: undefined })).toThrow(
        "EXPO_PUBLIC_PHONE_COUNTRY_CODE",
      );
    }
  });

  it("refuses a resend wait that is not a positive whole number", () => {
    for (const resendSeconds of ["0", "-5", "2.5", "soon"]) {
      expect(() => readPhoneConfig({ countryCode: undefined, resendSeconds })).toThrow(
        "EXPO_PUBLIC_OTP_RESEND_SECONDS",
      );
    }
  });
});
