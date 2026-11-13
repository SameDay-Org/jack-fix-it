import { screen, waitFor } from "@testing-library/react-native";

import { apiGet, NetworkError } from "@/api";
import i18n from "@/i18n";

import { created } from "../../request/__tests__/helpers";
import { RequestPreferred } from "../RequestPreferred";
import { myRequestQueryKey } from "../useMyRequest";
import { newQueryClient, renderWithQuery, REQUEST_ID } from "./helpers";

jest.mock("@/api", () => ({
  ...jest.requireActual("../../../api/errors"),
  apiGet: jest.fn(),
}));
jest.mock(
  "react-native-safe-area-context",
  () => jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

const LINE = "request-preferred";

beforeEach(() => jest.mocked(apiGet).mockReset());
afterEach(() => i18n.changeLanguage("en"));

describe("RequestPreferred", () => {
  it("asks for the customer's own request and names its day with the time of day", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValue(created({ preferred_date: "2026-11-04", preferred_period: "morning" }));
    await renderWithQuery(<RequestPreferred requestId={REQUEST_ID} />);

    expect(await screen.findByTestId(LINE)).toHaveTextContent(
      /^Preferred: Wed,\sNov\s4\s· Morning$/,
    );
    expect(apiGet).toHaveBeenCalledWith("/v1/requests/{request_id}", {
      auth: true,
      signal: expect.any(AbortSignal),
      params: { request_id: REQUEST_ID },
    });
  });

  it("names the day alone when the time is flexible or predates periods", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(
        created({ preferred_date: "2026-11-04", preferred_period: "flexible" }),
      )
      .mockResolvedValueOnce(created({ preferred_date: "2026-11-04", preferred_period: null }));
    await renderWithQuery(
      <>
        <RequestPreferred requestId="flexible" />
        <RequestPreferred requestId="legacy" />
      </>,
    );

    await waitFor(() => expect(screen.getAllByTestId(LINE)).toHaveLength(2));
    for (const line of screen.getAllByTestId(LINE)) {
      expect(line).toHaveTextContent(/^Preferred: Wed, Nov 4$/);
    }
  });

  it("reads in Spanish", async () => {
    await i18n.changeLanguage("es");
    jest
      .mocked(apiGet)
      .mockResolvedValue(created({ preferred_date: "2026-11-04", preferred_period: "evening" }));
    await renderWithQuery(<RequestPreferred requestId={REQUEST_ID} />);

    expect(await screen.findByTestId(LINE)).toHaveTextContent(/^Preferencia: .+· Noche$/);
  });

  it("shows nothing for a request with no day, while loading, or when the request fails", async () => {
    jest
      .mocked(apiGet)
      .mockResolvedValueOnce(created({ preferred_date: null, preferred_period: null }))
      .mockRejectedValueOnce(new NetworkError(false))
      .mockReturnValueOnce(new Promise(() => undefined));
    const client = newQueryClient();
    const status = (id: string) => client.getQueryState(myRequestQueryKey(id))?.status;
    await renderWithQuery(
      <>
        <RequestPreferred requestId="no-day" />
        <RequestPreferred requestId="failing" />
        <RequestPreferred requestId="loading" />
      </>,
      client,
    );

    // Each answer is in (and rendered) before the absence counts.
    await waitFor(() => expect(status("no-day")).toBe("success"));
    await waitFor(() => expect(status("failing")).toBe("error"));
    expect(status("loading")).toBe("pending");
    expect(screen.queryByTestId(LINE)).toBeNull();
  });
});
