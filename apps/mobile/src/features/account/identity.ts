import type { SessionUser } from "@/api";
import type { StatusTone } from "@/components/ui";

/** The role badge's tone: the person's own role reads as information, a pro's as the brand. */
export const ROLE_TONE: Record<SessionUser["role"], StatusTone> = {
  customer: "info",
  pro: "brand",
  agent: "neutral",
  admin: "neutral",
};

/** First and last name as one line, or null for an account created before names. */
export function fullName(user: SessionUser): string | null {
  const name = [user.first_name, user.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}
