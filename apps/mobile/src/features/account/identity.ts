import type { SessionUser } from "@/api";
import type { IdCardVariant, StatusTone } from "@/components/ui";
import { phoneConfig } from "@/features/phone/config";
import { formatE164 } from "@/features/phone/phoneNumber";

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

/** What the ID card shows of a user: the person's own phone too, which a shared image never carries. */
export type CardDetails = {
  variant: IdCardVariant;
  name: string;
  city?: string;
  state?: string;
  phone?: string;
  photoUri?: string;
  publicCode: string;
};

/**
 * The card's content from `/auth/me` (#290): a pro's card for a pro, a customer's for everyone else.
 * An older account may have no name, city or photo: the card leaves the line out or shows the
 * silhouette. The phone appears once verified, formatted for the region.
 */
export function cardDetails(user: SessionUser): CardDetails {
  return {
    variant: user.role === "pro" ? "pro" : "customer",
    name: fullName(user) ?? "",
    city: user.home_city ?? undefined,
    state: user.home_state ?? undefined,
    phone:
      user.phone_verified && user.phone
        ? formatE164(user.phone, phoneConfig.countryCode)
        : undefined,
    photoUri: user.photo?.url,
    publicCode: user.public_code,
  };
}
