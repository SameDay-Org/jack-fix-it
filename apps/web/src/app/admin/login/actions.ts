"use server";

import { redirect } from "next/navigation";

import { ApiError, apiPost } from "@/lib/api";
import { type AuthResponse, isStaff, PANEL_PATH, revoke, startSession } from "@/lib/session";

/** The login outcomes the form shows, each with its own i18n message. */
export type LoginError =
  "invalid_credentials" | "account_suspended" | "rate_limited" | "not_staff" | "unavailable";

/** `email` refills the field after a failed attempt (React resets the form); never the password. */
export type LoginState = { error: LoginError | null; email: string };

function errorOf(failure: unknown): LoginError {
  if (!(failure instanceof ApiError)) return "unavailable"; // network or configuration
  if (failure.code === "account_suspended") return "account_suspended";
  if (failure.status === 429) return "rate_limited";
  // A malformed email is a 422: to the person it is the same "incorrect" message.
  if (failure.status === 401 || failure.status === 422) return "invalid_credentials";
  return "unavailable";
}

/**
 * Staff sign-in. Calls the API's login; a customer or pro account is signed out at once
 * (its refresh token revoked) and gets no cookie. Never logs the email, the password or a
 * token. Next.js checks that a server action's Origin matches the host, so another site
 * cannot post this form.
 */
export async function login(_previous: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "invalid_credentials", email };

  let tokens: AuthResponse;
  try {
    tokens = await apiPost("/v1/auth/login", { email, password });
  } catch (failure) {
    return { error: errorOf(failure), email };
  }
  if (!isStaff(tokens.user)) {
    await revoke(tokens.refresh_token);
    return { error: "not_staff", email };
  }
  await startSession(tokens);
  redirect(PANEL_PATH);
}
