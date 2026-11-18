import type { apiGet } from "@/api";

import type { Earning, EarningsPage, EarningsSummary } from "../api";

export {
  freezeClock,
  navigation,
  newQueryClient,
  renderWithQuery,
  routerMock,
} from "../../opportunities/__tests__/helpers";
export { apiMock } from "../../pro-jobs/__tests__/helpers";
export { signedIn } from "../../home/__tests__/helpers";

export const EARNINGS = "/v1/pros/me/earnings";
export const PROFILE = "/v1/pros/me";

/** The API's totals: never the sum of any rows below, so a total added up from rows shows. */
export const SUMMARY: EarningsSummary = {
  paid_cents: 154_000,
  pending_cents: 9_050,
  awaiting_confirmation_cents: 4_500,
  on_hold_cents: 2_500,
  currency: "usd",
};

export const ZERO: EarningsSummary = {
  paid_cents: 0,
  pending_cents: 0,
  awaiting_confirmation_cents: 0,
  on_hold_cents: 0,
  currency: "usd",
};

export const jobId = (n: number) =>
  `00000000-0000-4000-8000-0000000070${String(n).padStart(2, "0")}`;

const CLEANING = { slug: "house-cleaning", names: { en: "House cleaning", es: "Limpieza" } };

/** A paid job by default: completed Nov 10, paid Nov 12. */
export const earning = (n: number, overrides: Partial<Earning> = {}): Earning => ({
  job_id: jobId(n),
  category: CLEANING,
  amount_cents: 12_000,
  status: "paid",
  completed_at: "2026-11-10T15:00:00Z",
  paid_at: "2026-11-12T15:00:00Z",
  expected_by: null,
  ...overrides,
});

export const ON_THE_WAY = earning(2, {
  status: "on_the_way",
  amount_cents: 9_050,
  paid_at: null,
  category: { slug: "plumbing", names: { en: "Plumbing", es: "Plomería" } },
});
export const AWAITING = earning(3, {
  status: "awaiting_confirmation",
  amount_cents: 4_500,
  paid_at: null,
  expected_by: "2026-11-15T15:00:00Z",
});
export const ON_HOLD = earning(4, { status: "on_hold", amount_cents: 2_500, paid_at: null });

export const earningsPage = (
  items: Earning[],
  nextCursor: string | null = null,
  summary: EarningsSummary = SUMMARY,
): EarningsPage => ({ summary, items, next_cursor: nextCursor });

type Answer = (cursor: string | undefined) => Promise<unknown>;

type Sent = { query?: { cursor?: string } } | undefined;

/** Routes the mocked `apiGet`: the earnings to `earnings` (by cursor), the pro's profile to `profile`. */
export function routeApi(
  mock: jest.MockedFunction<typeof apiGet>,
  earnings: Answer,
  profile: () => Promise<unknown>,
) {
  // The mock answers two paths with two shapes, which the generic signature cannot express.
  const route = (path: string, options?: Sent) =>
    path === EARNINGS ? earnings(options?.query?.cursor) : profile();
  mock.mockImplementation(route as unknown as typeof apiGet);
}

/** The cursors the earnings were asked for, in order (`undefined`: the first page). */
export const earningsCursors = (mock: jest.MockedFunction<typeof apiGet>) =>
  mock.mock.calls
    .filter(([path]) => path === EARNINGS)
    .map(([, options]) => (options as Sent)?.query?.cursor);
