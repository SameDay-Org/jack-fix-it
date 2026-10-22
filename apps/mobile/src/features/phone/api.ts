import { useMutation } from "@tanstack/react-query";

import { apiPost } from "@/api";

/** Texts a verification code to an E.164 number. The server answers 202 whether or not it sends. */
export function useSendCode() {
  return useMutation({
    mutationFn: ({ phone, signal }: { phone: string; signal?: AbortSignal }) =>
      apiPost("/v1/auth/phone/send", { phone }, { auth: true, signal }),
  });
}

/**
 * Checks the code and resolves with the verified user. The caller hands that user to the session
 * (`setSessionUser`) only while its screen is still there, so a late answer writes nothing.
 */
export function useVerifyCode() {
  return useMutation({
    mutationFn: ({ signal, ...body }: { phone: string; code: string; signal?: AbortSignal }) =>
      apiPost("/v1/auth/phone/verify", body, { auth: true, signal }),
  });
}
