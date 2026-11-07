import type { ProJob, ProJobPage } from "../phase";

export {
  fakeClock,
  freezeClock,
  newQueryClient,
  renderWithQuery,
} from "../../quotes/__tests__/helpers";
export { navigation, routerMock } from "../../opportunities/__tests__/helpers";
export { signedIn } from "../../home/__tests__/helpers";

/** 2026-10-28 14:00 UTC, the clock the shared helpers freeze; fixture times are relative to it. */
export const NOW = Date.parse("2026-10-28T14:00:00Z");
const MINUTE_MS = 60_000;
export const minutesFromNow = (minutes: number) =>
  new Date(NOW + minutes * MINUTE_MS).toISOString();
export const hoursFromNow = (hours: number) => minutesFromNow(hours * 60);

/** The job the screens open by default (the router mock's `id` param is set to it per test). */
export const JOB_ID = "00000000-0000-4000-8000-000000000630";
/** The arrival code the customer reads out in every fixture: test data, never a real one. */
export const ARRIVAL_CODE = "4821";

export const PAINTING = {
  id: "00000000-0000-4000-8000-000000000003",
  slug: "painting",
  names: { en: "Painting", es: "Pintura" },
};

/** A scheduled job three hours from now, for Maria, paying the pro $153.00. */
export const proJob = (overrides: Partial<ProJob> = {}): ProJob => ({
  id: JOB_ID,
  status: "scheduled",
  scheduled_start_at: hoursFromNow(3),
  category: PAINTING,
  description: "The hallway and two bedrooms need a fresh coat of eggshell white.",
  address: {
    line1: "1200 Las Olas Blvd",
    line2: "Apt 4",
    city: "Fort Lauderdale",
    state: "FL",
    zip_code: "33301",
  },
  customer_first_name: "Maria",
  eta_at: null,
  checked_in_at: null,
  arrival_code_locked: false,
  started_at: null,
  completed_at: null,
  photos: { before: [], after: [] },
  pro_payout_cents: 15_300,
  unread_messages: 0,
  ...overrides,
});

/** The same job, on the way with an arrival time 20 minutes from now. */
export const onTheWay = (overrides: Partial<ProJob> = {}): ProJob =>
  proJob({ status: "on_the_way", eta_at: minutesFromNow(20), ...overrides });

/** On the way and checked in five minutes ago: ready to start. */
export const arrived = (overrides: Partial<ProJob> = {}): ProJob =>
  onTheWay({ checked_in_at: minutesFromNow(-5), ...overrides });

/** Started ten minutes ago. */
export const working = (overrides: Partial<ProJob> = {}): ProJob =>
  arrived({ status: "in_progress", started_at: minutesFromNow(-10), ...overrides });

/** The nth job (n < 100), with its own id. */
export const jobN = (n: number, overrides: Partial<ProJob> = {}): ProJob =>
  proJob({ id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, "0")}`, ...overrides });

export const jobPage = (items: ProJob[], next_cursor: string | null = null): ProJobPage => ({
  items,
  next_cursor,
});

/**
 * `@/api` for these suites: the real errors, mocked calls, and a session whose generation a test
 * moves (`mockSession.generation += 1` is a sign-out followed by another sign-in). Use it as
 * `jest.mock("@/api", () => jest.requireActual("./helpers").apiMock())`.
 */
export function apiMock() {
  const session = { generation: 1 };
  const signOutListeners = new Set<() => void>();
  return {
    ...jest.requireActual("../../../api/errors"),
    apiGet: jest.fn(),
    apiPost: jest.fn(),
    uploadMedia: jest.fn(),
    useSession: jest.fn(),
    mockSession: session,
    sessionGeneration: () => session.generation,
    useSessionGeneration: () => session.generation,
    isCurrentGeneration: (generation: number) => generation === session.generation,
    onSignOut: (listener: () => void) => {
      signOutListeners.add(listener);
      return () => {
        signOutListeners.delete(listener);
      };
    },
    /** The account boundary: what `onSignOut` registered runs, and the generation moves on. */
    mockSignOut: () => {
      session.generation += 1;
      signOutListeners.forEach((listener) => listener());
    },
  };
}
