import type { PostResponse } from "@/api";

import type { Payouts, PayoutsStatus } from "../api";

export {
  navigation,
  newQueryClient,
  renderWithQuery,
  routerMock,
  signedIn,
} from "../../pro-documents/__tests__/helpers";
export { apiMock } from "../../pro-profile/__tests__/helpers";

export const PAYOUTS = "/v1/pros/me/payouts";
export const ONBOARDING_LINK = "/v1/pros/me/payouts/onboarding-link";
export const PROFILE = "/v1/pros/me";

/**
 * Every setup link of these suites carries this mark, in its host, its path and its account id:
 * none of it may reach a cache, a state, a screen or a log. Test data, never a real link.
 */
export const LINK_MARK = "LINK-SENTINEL";
export const SETUP_LINK = `https://connect.${LINK_MARK}.test/setup/s/${LINK_MARK}-acct_1${LINK_MARK}`;

/** A fresh link, as POST /v1/pros/me/payouts/onboarding-link answers. */
export const link = (): PostResponse<"/v1/pros/me/payouts/onboarding-link"> => ({
  url: SETUP_LINK,
  expires_at: "2999-01-01T00:00:00Z",
});

/** The status as the API answers it: payouts are on exactly when it says `enabled`. */
export const payouts = (status: PayoutsStatus): Payouts => ({
  status,
  payouts_enabled: status === "enabled",
});

/** Where the API's return and refresh pages send the browser. */
export const RETURN_LINK = "jackfixit://payouts?result=return";
export const REFRESH_LINK = "jackfixit://payouts?result=refresh";
