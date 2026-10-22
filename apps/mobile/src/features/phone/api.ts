import { apiPost } from "@/api";

/*
 * The phone flow's two calls, as plain functions rather than TanStack Query mutations: a mutation
 * keeps its variables (the number, the code) in the app-wide MutationCache after the screen is
 * gone. Called straight from the hooks, the number and the code live only in their state and end
 * with the screen.
 */

/** Texts a verification code to an E.164 number. The server answers 202 whether or not it sends. */
export const sendCode = (phone: string, signal: AbortSignal) =>
  apiPost("/v1/auth/phone/send", { phone }, { auth: true, signal });

/**
 * Checks the code and resolves with the verified user. The caller hands that user to the session
 * (`setSessionUser`) only while its screen is still there, so a late answer writes nothing.
 */
export const verifyCode = (phone: string, code: string, signal: AbortSignal) =>
  apiPost("/v1/auth/phone/verify", { phone, code }, { auth: true, signal });
