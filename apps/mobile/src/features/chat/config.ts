/** How the job chat keeps itself fresh, read once at startup. */
export type ChatConfig = {
  /** How often an open chat asks for the newest messages (no live updates yet, #73). */
  readonly pollMs: number;
};

export const DEFAULT_CHAT_POLL_SECONDS = 5;
const MS_PER_SECOND = 1000;

/**
 * The longest message the API takes, in characters (code points): `ChatMessageIn.body.maxLength`
 * in the contract (a test reads it from `packages/shared/openapi.json`, so the two never drift).
 */
export const MESSAGE_MAX_LENGTH = 2000;

/** The composer shows how many characters are left from this many on. */
export const MESSAGE_COUNTER_FROM = 200;

/** Validates the raw environment value. Pure, so tests can cover every branch. */
export function readChatConfig(raw: { pollSeconds: string | undefined }): ChatConfig {
  const pollSeconds = raw.pollSeconds ? Number(raw.pollSeconds) : DEFAULT_CHAT_POLL_SECONDS;
  if (!Number.isInteger(pollSeconds) || pollSeconds <= 0) {
    throw new Error("EXPO_PUBLIC_CHAT_POLL_SECONDS must be a positive whole number");
  }
  return { pollMs: pollSeconds * MS_PER_SECOND };
}

// A literal `process.env.EXPO_PUBLIC_*` read: Metro inlines it at build time.
export const chatConfig: ChatConfig = readChatConfig({
  pollSeconds: process.env.EXPO_PUBLIC_CHAT_POLL_SECONDS,
});
