import type { JobPhoto } from "../AfterPhotos";
import type { CustomerJob } from "../phase";

/** 2026-10-28 14:00 UTC, the clock the shared helpers freeze; fixture times are relative to it. */
export const NOW = Date.parse("2026-10-28T14:00:00Z");
const MINUTE_MS = 60_000;
export const at = (minutes: number) => new Date(NOW + minutes * MINUTE_MS).toISOString();

/** An after photo whose signed URL is good for an hour unless the test says otherwise. */
export const afterPhoto = (n: number, overrides: Partial<JobPhoto> = {}): JobPhoto => ({
  id: `00000000-0000-4000-8000-00000000066${n}`,
  content_type: "image/jpeg",
  url: `https://media.example.test/after-${n}.jpg`,
  expires_at: at(60),
  ...overrides,
});

/** The customer's job, finished by Dan 10 minutes ago: it confirms itself in 47 h 50 min. */
export const customerJob = (overrides: Partial<CustomerJob> = {}): CustomerJob => ({
  id: "6f1c2a40-0000-4000-8000-000000000660",
  status: "completed",
  customer_status: "customerStatus.completed",
  scheduled_start_at: at(-120),
  pro: {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Dan K.",
    rating_avg: "4.80",
    jobs_count: 12,
    years_of_experience: 8,
    verified: true,
  },
  eta_at: null,
  arrival_code: null,
  confirm_by: at(48 * 60 - 10),
  timeline: [
    { type: "created", status: "scheduled", at: at(-180) },
    { type: "status_changed", status: "completed", at: at(-10) },
  ],
  amount_cents: 18_000,
  tax_cents: 1_485,
  customer_total_cents: 19_485,
  photos: { before: [], after: [afterPhoto(1), afterPhoto(2)], pending: 0 },
  unread_messages: 0,
  ...overrides,
});

/** The same job once confirmed: no deadline any more. */
export const confirmedJob = (overrides: Partial<CustomerJob> = {}): CustomerJob =>
  customerJob({
    status: "confirmed",
    customer_status: "customerStatus.confirmed",
    confirm_by: null,
    ...overrides,
  });
