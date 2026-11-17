/** Fixtures of the queue page tests: requests as the API returns them. Tests only. */
import type { QueueItem, QueueSummary, RequestCard } from "./queue";

export const REQUEST_ID = "81a0f3a5-1111-4222-8333-944455556681";
export const OTHER_REQUEST_ID = "81a0f3a5-2222-4333-8444-055566667781";
export const CATEGORY_ID = "c0a7e901-1111-4222-8333-944455556681";
export const AGENT_ID = "a9e07f3a-1111-4222-8333-944455556681";
export const NOW = "2026-11-07T14:30:00Z";
export const DESCRIPTION = "The kitchen faucet drips.\nCall me at 305-555-0181 <b>today</b>.";
export const MEDIA_URL = "https://storage.test.invalid/get/m/safe.jpg?sig=probe";

const PLUMBING = { id: CATEGORY_ID, slug: "plumbing", names: { en: "Plumbing", es: "Plomería" } };

export function summary(extra: Partial<QueueSummary> = {}): QueueSummary {
  return {
    problems: 1,
    urgent: 4,
    new: 7,
    waiting_customer: 2,
    waiting_pro: 3,
    quote_ready: 5,
    scheduled_today: 6,
    all: 40,
    first_contact_sla_minutes: 5,
    ...extra,
  };
}

/** A new request created two minutes before NOW, with five minutes for the first contact. */
export function item(extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: REQUEST_ID,
    public_code: "JF-000181",
    customer_name: "Ana P.",
    category: PLUMBING,
    zip_code: "33301",
    status: "received",
    customer_status: "customerStatus.requestReceived",
    origin: "app",
    urgency: null,
    bucket: "new",
    created_at: "2026-11-07T14:28:00Z",
    first_contact_due_at: "2026-11-07T14:33:00Z",
    first_contact_at: null,
    assigned_agent: null,
    media_count: 0,
    ...extra,
  };
}

export function card(extra: Partial<RequestCard> = {}): RequestCard {
  return {
    ...item(),
    customer: {
      id: "c057f3a5-1111-4222-8333-944455556681",
      first_name: "Ana",
      last_name: "Probelast",
      phone: "+13055550181",
      email: "ana.probe+81@example.com",
      language: "es",
    },
    address: {
      line1: "742 Evergreen Terrace",
      line2: "Apt 81",
      city: "Fort Lauderdale",
      state: "FL",
      zip_code: "33301",
    },
    description: DESCRIPTION,
    intake_answers: { leak_location: "Under the sink", urgent: true },
    preferred_date: "2026-11-09",
    preferred_period: "morning",
    preferred_contact: null,
    media: [{ kind: "photo", content_type: "image/jpeg", url: MEDIA_URL, expires_at: NOW }],
    media_pending: 1,
    quotes: [
      {
        id: "900f3a51-1111-4222-8333-944455556681",
        pro_name: "María P.",
        amount_cents: 18_550,
        status: "pending",
        proposed_start_at: "2026-11-09T15:00:00Z",
        created_at: NOW,
      },
    ],
    job: null,
    next_action: null,
    last_contact_at: null,
    updated_at: NOW,
    ...extra,
  };
}
