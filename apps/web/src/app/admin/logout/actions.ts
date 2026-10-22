"use server";

import { redirect } from "next/navigation";

import { endSession, LOGIN_PATH } from "@/lib/session";

/** Signs out: revokes the refresh token (best effort), always clears the cookies. */
export async function logout(): Promise<never> {
  await endSession();
  redirect(LOGIN_PATH);
}
