// Manual Jest mock, applied to every suite (root __mocks__): the browser session "opens" and the
// pro closes it at once; a test reads the url and the return link off `openAuthSessionAsync`, and
// answers as the return page would with `mockResolvedValueOnce({ type: "success", url })`.
import type { AuthSessionOpenOptions, WebBrowserAuthSessionResult } from "expo-web-browser";

export const openAuthSessionAsync = jest.fn(
  async (
    _url: string,
    _redirectUrl?: string | null,
    _options?: AuthSessionOpenOptions,
  ): Promise<WebBrowserAuthSessionResult> => ({ type: "cancel" }) as WebBrowserAuthSessionResult,
);
