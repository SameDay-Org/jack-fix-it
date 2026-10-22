import { useMutation } from "@tanstack/react-query";

import { apiPost, setSessionUser } from "@/api";

/** Texts a verification code to an E.164 number. The server answers 202 whether or not it sends. */
export function useSendCode() {
  return useMutation({
    mutationFn: (phone: string) => apiPost("/v1/auth/phone/send", { phone }, { auth: true }),
  });
}

/** Checks the code; on success the session's user becomes the verified one the server returns. */
export function useVerifyCode() {
  return useMutation({
    mutationFn: (body: { phone: string; code: string }) =>
      apiPost("/v1/auth/phone/verify", body, { auth: true }),
    onSuccess: (user) => setSessionUser(user),
  });
}
