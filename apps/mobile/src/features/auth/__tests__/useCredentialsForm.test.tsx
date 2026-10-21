import "@/i18n";

import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { ApiError } from "@/api";

import { deferred } from "../../../api/__tests__/helpers";
import { useCredentialsForm } from "../useCredentialsForm";

jest.mock(
  "../../../api/config",
  () => jest.requireActual("../../../api/__tests__/helpers").configMock,
);
jest.mock(
  "expo-secure-store",
  () => jest.requireActual("../../../api/__tests__/helpers").secureStoreMock,
);

const CREDENTIALS = { email: "maria@example.com", password: "correct horse battery" };

async function filledForm(submit: jest.Mock) {
  const rendered = await renderHook(() => useCredentialsForm(submit));
  await act(async () => {
    rendered.result.current.setEmail(CREDENTIALS.email);
    rendered.result.current.setPassword(CREDENTIALS.password);
  });
  return rendered;
}

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => undefined);
});

describe("useCredentialsForm", () => {
  it("two submits in the same turn send one request", async () => {
    const pending = deferred<void>();
    const submit = jest.fn(() => pending.promise);
    const { result } = await filledForm(submit);

    await act(async () => {
      void result.current.submitForm();
      void result.current.submitForm(); // before React commits `submitting`
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.submitting).toBe(true);
    pending.resolve();
    await waitFor(() => expect(result.current.submitting).toBe(false));
  });

  it("the guard is released after a failure, so a retry sends again", async () => {
    const submit = jest
      .fn<Promise<void>, [unknown]>()
      .mockRejectedValueOnce(new ApiError(401, "invalid_credentials"))
      .mockResolvedValueOnce(undefined);
    const { result } = await filledForm(submit);

    await act(async () => {
      await result.current.submitForm();
    });
    expect(result.current.failure?.message).toBe("Email or password is incorrect.");
    expect(result.current.submitting).toBe(false);

    await act(async () => {
      await result.current.submitForm();
    });

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith(CREDENTIALS);
  });

  it("the guard is released after a validation failure too", async () => {
    const submit = jest.fn(async () => undefined);
    const rendered = await renderHook(() => useCredentialsForm(submit));

    await act(async () => {
      await rendered.result.current.submitForm(); // empty fields: validation fails
    });
    expect(rendered.result.current.fieldErrors.email).toBe("Enter a valid email address.");
    expect(submit).not.toHaveBeenCalled();

    await act(async () => {
      rendered.result.current.setEmail(CREDENTIALS.email);
      rendered.result.current.setPassword(CREDENTIALS.password);
    });
    await act(async () => {
      await rendered.result.current.submitForm();
    });

    expect(submit).toHaveBeenCalledTimes(1);
  });
});
