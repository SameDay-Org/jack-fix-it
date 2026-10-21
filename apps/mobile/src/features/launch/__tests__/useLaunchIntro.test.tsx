import { act, renderHook } from "@testing-library/react-native";

import type { SessionStatus } from "@/api";
import { tokens } from "@/theme";

import { useLaunchIntro } from "../useLaunchIntro";

const { launchMinMs, launchMaxMs } = tokens.motion;

type Props = { status: SessionStatus; reduceMotion: boolean };

async function renderIntro(initial: Props) {
  return renderHook((props: Props) => useLaunchIntro(props), { initialProps: initial });
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

    const resolved = await renderIntro({ status: "signedOut", reduceMotion: true });
    expect(resolved.result.current.phase).toBe("exiting");
  });
});
