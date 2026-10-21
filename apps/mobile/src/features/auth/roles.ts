import type { PostBody } from "@/api";

/** The roles an account can be created with; agents and admins are made elsewhere. */
export type SignUpRole = PostBody<"/v1/auth/register">["role"];

const SIGN_UP_ROLES: readonly SignUpRole[] = ["customer", "pro"];

export const isSignUpRole = (value: unknown): value is SignUpRole =>
  typeof value === "string" && (SIGN_UP_ROLES as readonly string[]).includes(value);
