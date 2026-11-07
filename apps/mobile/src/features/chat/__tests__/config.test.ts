import openapi from "../../../../../../packages/shared/openapi.json";
import {
  DEFAULT_CHAT_POLL_SECONDS,
  MESSAGE_COUNTER_FROM,
  MESSAGE_MAX_LENGTH,
  readChatConfig,
} from "../config";

describe("readChatConfig", () => {
  it("polls every 5 s when the variable is unset or empty", () => {
    expect(DEFAULT_CHAT_POLL_SECONDS).toBe(5);
    expect(readChatConfig({ pollSeconds: undefined })).toStrictEqual({ pollMs: 5000 });
    expect(readChatConfig({ pollSeconds: "" })).toStrictEqual({ pollMs: 5000 });
  });

  it("turns a whole number of seconds into milliseconds", () => {
    expect(readChatConfig({ pollSeconds: "12" })).toStrictEqual({ pollMs: 12_000 });
    expect(readChatConfig({ pollSeconds: "1" })).toStrictEqual({ pollMs: 1000 });
  });

  it.each(["0", "-1", "1.5", "abc", "Infinity"])("refuses %p, naming the variable", (value) => {
    expect(() => readChatConfig({ pollSeconds: value })).toThrow(/EXPO_PUBLIC_CHAT_POLL_SECONDS/);
  });
});

describe("the message limits", () => {
  it("take the API's longest message (ChatMessageIn in the committed OpenAPI schema)", () => {
    expect(MESSAGE_MAX_LENGTH).toBe(
      openapi.components.schemas.ChatMessageIn.properties.body.maxLength,
    );
  });

  it("start the counter before the limit", () => {
    expect(MESSAGE_COUNTER_FROM).toBeGreaterThan(0);
    expect(MESSAGE_COUNTER_FROM).toBeLessThan(MESSAGE_MAX_LENGTH);
  });
});
