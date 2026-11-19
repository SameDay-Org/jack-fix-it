import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiGet, useSession } from "@/api";

import { newQueryClient, signedIn } from "../../home/__tests__/helpers";
import { fakeClock } from "../../quotes/__tests__/helpers";
import { useMyProProfile } from "../api";
import { proProfileConfig } from "../config";
import { FULL_PROFILE } from "./helpers";

jest.mock("@/api", () => jest.requireActual("../../pro-jobs/__tests__/helpers").apiMock());

const PROFILE = "/v1/pros/me";
const profileReads = () => jest.mocked(apiGet).mock.calls.filter(([path]) => path === PROFILE);

function renderProfile(pollWhilePending: boolean) {
  const client = newQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMyProProfile({ pollWhilePending }), { wrapper });
}

beforeEach(() => {
  fakeClock();
  jest.mocked(useSession).mockReturnValue(signedIn({ role: "pro" }));
  jest.mocked(apiGet).mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useMyProProfile: the pending review is asked about again (#476)", () => {
  it("polls while the review is pending, and stops once it is approved", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce({ ...FULL_PROFILE, verification_status: "pending" })
      .mockResolvedValue({ ...FULL_PROFILE, verification_status: "approved" });
    const { result } = await renderProfile(true);
    await waitFor(() => expect(result.current.data?.verification_status).toBe("pending"));

    await act(async () => jest.advanceTimersByTime(proProfileConfig.reviewPollMs));
    await waitFor(() => expect(result.current.data?.verification_status).toBe("approved"));
    expect(profileReads()).toHaveLength(2);

    await act(async () => jest.advanceTimersByTime(proProfileConfig.reviewPollMs * 3));
    expect(profileReads()).toHaveLength(2);
  });

  it("asks nothing on its own when the screen does not ask it to poll", async () => {
    jest.mocked(apiGet).mockResolvedValue({ ...FULL_PROFILE, verification_status: "pending" });
    const { result } = await renderProfile(false);
    await waitFor(() => expect(result.current.data?.verification_status).toBe("pending"));

    await act(async () => jest.advanceTimersByTime(proProfileConfig.reviewPollMs * 3));
    expect(profileReads()).toHaveLength(1);
  });
});
