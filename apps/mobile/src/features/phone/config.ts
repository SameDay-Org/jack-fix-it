/** Phone verification settings, read once at startup. The server stays the authority on both. */
export type PhoneConfig = {
  /** The calling code shown before the number and prefixed to it, like `+1`. */
  readonly countryCode: string;
  /** How long "Resend code" waits after a code was sent, in seconds. */
  readonly resendSeconds: number;
};

/** Digits in an SMS code: Twilio Verify's default length, which the server's service uses. */
export const CODE_LENGTH = 6;

export const DEFAULT_COUNTRY_CODE = "+1";
export const DEFAULT_RESEND_SECONDS = 30;

// A plus and one to three digits, never starting with 0 (ITU-T E.164 calling codes).
const CALLING_CODE = /^\+[1-9][0-9]{0,2}$/;

type RawConfig = { countryCode: string | undefined; resendSeconds: string | undefined };

/** Validates the raw environment values. Pure, so tests can cover every branch. */
export function readPhoneConfig({ countryCode, resendSeconds }: RawConfig): PhoneConfig {
  const code = countryCode || DEFAULT_COUNTRY_CODE;
  if (!CALLING_CODE.test(code)) {
    throw new Error("EXPO_PUBLIC_PHONE_COUNTRY_CODE must be a calling code such as +1");
  }
  const seconds = resendSeconds ? Number(resendSeconds) : DEFAULT_RESEND_SECONDS;
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("EXPO_PUBLIC_OTP_RESEND_SECONDS must be a positive whole number");
  }
  return { countryCode: code, resendSeconds: seconds };
}

// Literal `process.env.EXPO_PUBLIC_*` reads: Metro inlines them at build time.
export const phoneConfig: PhoneConfig = readPhoneConfig({
  countryCode: process.env.EXPO_PUBLIC_PHONE_COUNTRY_CODE,
  resendSeconds: process.env.EXPO_PUBLIC_OTP_RESEND_SECONDS,
});
