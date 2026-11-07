import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";
import { useGuardedPush } from "@/features/quotes/navigation";

import { chatHref } from "./api";
import { isChatClosed } from "./peer";
import type { JobStatus } from "@/features/jobs/phase";

export type ChatEntryProps = {
  jobId: string;
  /** The customer's request the job belongs to; the pro's link has none. */
  requestId?: string;
  /** The other side inside a sentence ("Dan", "your pro"). */
  name: string;
  status: JobStatus;
  /** Their messages the caller has not read (`unread_messages` on the job view). */
  unread: number;
};

/**
 * The way from a job screen into its chat: "Message Dan" with the unread count beside it, or,
 * once the chat is read-only, "View messages" (the conversation stays readable; nothing offers a
 * send that would be refused).
 */
export function ChatEntry({ jobId, requestId, name, status, unread }: ChatEntryProps) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const label = isChatClosed(status) ? t("chat.entry.view") : t("chat.entry.message", { name });
  const unreadText = unread > 0 ? t("chat.entry.unread", { count: unread }) : null;
  return (
    <Button
      variant="secondary"
      label={label}
      accessibilityLabel={
        unreadText ? t("chat.entry.label", { action: label, unread: unreadText }) : label
      }
      badge={unread}
      onPress={() => push(chatHref(jobId, requestId))}
      testID="chat-entry"
    />
  );
}
