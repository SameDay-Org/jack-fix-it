import { act, renderHook } from "@testing-library/react-native";

import type { SessionStatus } from "@/api";
import { tokens } from "@/theme";

import { useLaunchIntro } from "../useLaunchIntro";

const { launchMinMs, launchMaxMs } = tokens.motion;

type Props = { status: SessionStatus; reduceMotion: boolean; runDone?: boolean };

/** The rotator's run has settled unless a test says otherwise. */
async function renderIntro(initial: Props) {
  return renderHook((props: Props) => useLaunchIntro({ runDone: true, ...props }), {
    initialProps: initial,
  });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("useLaunchIntro", () => {
  it("ends after launchMinMs when the session is resolved", async () => {
    const { result } = await renderIntro({ status: "signedOut", reduceMotion: false });
    expect(result.current.phase).toBe("running");

    await act(async () => jest.advanceTimersByTime(launchMinMs - 1));
    expect(result.current.phase).toBe("running");

    await act(async () => jest.advanceTimersByTime(1));
    expect(result.current.phase).toBe("exiting");
  });

  it("waits for restoring up to launchMaxMs, then ends anyway", async () => {
    const { result, rerender } = await renderIntro({ status: "restoring", reduceMotion: false });

    await act(async () => jest.advanceTimersByTime(launchMinMs));
    expect(result.current.phase).toBe("running"); // nothing to hand off to yet

    await act(async () => jest.advanceTimersByTime(launchMaxMs - launchMinMs));
    expect(result.current.phase).toBe("exiting"); // never later than this

    await rerender({ status: "signedIn", reduceMotion: false });
    expect(result.current.phase).toBe("exiting");
  });

  it("a session that resolves after the minimum ends the intro at once", async () => {
    const { result, rerender } = await renderIntro({ status: "restoring", reduceMotion: false });
    await act(async () => jest.advanceTimersByTime(launchMinMs + 100));
    expect(result.current.phase).toBe("running");

    await rerender({ status: "signedOut", reduceMotion: false });

    expect(result.current.phase).toBe("exiting");
  });

  it("after launchMinMs it still waits for the run to settle on the first word, never past launchMaxMs", async () => {
    const { result, rerender } = await renderIntro({
      status: "signedOut",
      reduceMotion: false,
      runDone: false,
    });
    await act(async () => jest.advanceTimersByTime(launchMinMs + 200));
    expect(result.current.phase).toBe("running"); // the last swap is still rolling

    await rerender({ status: "signedOut", reduceMotion: false, runDone: true });
    expect(result.current.phase).toBe("exiting");

    const stuck = await renderIntro({ status: "signedOut", reduceMotion: false, runDone: false });
    await act(async () => jest.advanceTimersByTime(launchMaxMs));
    expect(stuck.result.current.phase).toBe("exiting"); // a run that never ends cannot hold it
  });

  it("tap skips immediately", async () => {
    const { result } = await renderIntro({ status: "restoring", reduceMotion: false });

    await act(async () => result.current.skip());

    expect(result.current.phase).toBe("exiting");
  });

  it("reduce motion: no minimum, it ends as soon as the session is resolved", async () => {
    const restoring = await renderIntro({ status: "restoring", reduceMotion: true });
    expect(restoring.result.current.phase).toBe("running");
    await restoring.rerender({ status: "signedIn", reduceMotion: true });
    expect(restoring.result.current.phase).toBe("exiting");

    const resolved = await renderIntro({ status: "signedOut", reduceMotion: true, runDone: false });
    expect(resolved.result.current.phase).toBe("exiting"); // and no wait for the crossfade run
  });
});
