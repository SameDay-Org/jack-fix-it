import { useTranslation } from "react-i18next";

import { ChecklistCard, ChecklistCardSkeleton } from "@/components/ui";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useMyDocuments } from "@/features/pro-documents/api";
import type { DocumentState } from "@/features/pro-documents/documents";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";

import { documentsChecklist } from "./verification";

/** The two documents every pro sends: what the placeholder draws before the API says more. */
const PLACEHOLDER_STEPS = 2;

/** How a required document reads as a step: sent, rejected (to send again), or still to do. */
const STEP_KEY: Record<DocumentState, "stepSent" | "stepRejected" | "stepTodo"> = {
  pending: "stepSent",
  approved: "stepSent",
  rejected: "stepRejected",
  missing: "stepTodo",
};

/**
 * "Send your documents" on the pro's home (#38): the documents the API requires, each ticked
 * once it is sent, and the way to the documents screen. It shows while one is missing, was
 * rejected or expired, and leaves once all are in. Loading draws its shape; a failure offers a
 * retry.
 */
export function DocumentsChecklistCard({
  primary = true,
  testID = "documents-checklist",
}: {
  /** Whether its button is the screen's primary action: not while another card's is. */
  primary?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch } = useMyDocuments();
  const shownError = useSettledError(data, error);
  const push = useGuardedPush();

  if (data === undefined) {
    return shownError === null ? (
      <ChecklistCardSkeleton steps={PLACEHOLDER_STEPS} testID={`${testID}-loading`} />
    ) : (
      <RetryNotice
        message={t("proVerification.documents.loadFailed")}
        action={t("proVerification.retry")}
        onRetry={() => void refetch()}
        busy={isFetching}
        testID={`${testID}-error`}
      />
    );
  }
  const checklist = documentsChecklist(data);
  if (checklist.complete) return null;

  return (
    <ChecklistCard
      title={t("proVerification.documents.title")}
      progress={t("proVerification.documents.progress", {
        sent: checklist.sent,
        total: checklist.rows.length,
      })}
      steps={checklist.rows.map(({ type, state, expired }) => {
        const name = t(`proDocuments.types.${type}`);
        // An expired one says what to do: its name alone would read as already sent.
        const label = expired ? t("proVerification.documents.stepExpired", { name }) : name;
        return {
          id: type,
          label,
          done: STEP_KEY[state] === "stepSent",
          accessibilityLabel: expired
            ? label
            : t(`proVerification.documents.${STEP_KEY[state]}`, { name }),
        };
      })}
      actionLabel={t("proVerification.documents.action")}
      onAction={() => push("/pro/documents")}
      actionVariant={primary ? "primary" : "secondary"}
      testID={testID}
    />
  );
}
