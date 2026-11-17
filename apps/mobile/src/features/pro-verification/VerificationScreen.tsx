import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { NetworkError } from "@/api";
import { ACCOUNT_GLYPHS } from "@/components/icons";
import {
  Button,
  ListGroup,
  ListRow,
  Notice,
  Screen,
  StatusBadge,
  TextSkeleton,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { PayoutSetupCard } from "@/features/payouts";
import { useMyDocuments } from "@/features/pro-documents/api";
import type { MyDocuments } from "@/features/pro-documents/documents";
import { profileChecklist, useMyProProfile, type ProProfile } from "@/features/pro-profile";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useRefetchOnReturn, useSettledError } from "@/features/quotes/useRequestQuotes";

import { awaitsPayouts, documentsChecklist, rejectedDocuments, STATUS_TONE } from "./verification";

const HOME = "/";
const DOCUMENTS = "/pro/documents";

/**
 * The pro's verification status (`/pro/verification`, #38): Pending (the team reviews the
 * profile and the documents; no date is promised), Approved (what is next: payout setup, which
 * opens the payout screen, #277), or Rejected (the profile's reason, the reasons the review gave
 * on the documents, when it gave any, and the way to fix them).
 */
export function VerificationScreen() {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch } = useMyProProfile();
  const shownError = useSettledError(data, error);
  useRefetchOnReturn(refetch);

  let content: ReactNode;
  if (data !== undefined) {
    content = <Status profile={data} />;
  } else if (shownError !== null) {
    content = (
      <Notice
        tone="info"
        title={t("proVerification.loadFailed")}
        body={t(
          shownError instanceof NetworkError
            ? "proVerification.home.offline"
            : "proVerification.loadBody",
        )}
        testID="verification-load-failed"
      >
        <Button
          label={t("proVerification.retry")}
          variant="secondary"
          loading={isFetching}
          onPress={() => void refetch()}
          testID="verification-retry"
        />
      </Notice>
    );
  } else {
    content = (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("proVerification.loading")}
        className="gap-3"
        testID="verification-loading"
      >
        <TextSkeleton type="headline" width="55%" />
        <TextSkeleton type="callout" />
        <TextSkeleton type="callout" width="70%" />
      </View>
    );
  }

  return (
    <Screen bar="light" testID="verification-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref={HOME} />
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {t("proVerification.title")}
            </Text>
            {data ? (
              <StatusBadge
                label={t(`proVerification.status.${data.verification_status}`)}
                tone={STATUS_TONE[data.verification_status]}
                testID="verification-status"
              />
            ) : null}
          </View>
        </View>
        {content}
      </ScrollView>
    </Screen>
  );
}

/** What the status means and what the pro can do about it. */
function Status({ profile }: { profile: ProProfile }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  // The documents: how many are in (pending) and why some were refused (rejected). An approved
  // pro's screen asks for none.
  const status = profile.verification_status;
  const documents = useMyDocuments({ enabled: status !== "approved" });
  // The error a retry started from stays on screen while it runs (its button shows busy).
  const documentsError = useSettledError(documents.data, documents.error);

  if (status === "approved") {
    return (
      <>
        <Message
          title={t("proVerification.approved.title")}
          body={t(
            awaitsPayouts(profile)
              ? "proVerification.approved.payouts"
              : "proVerification.approved.ready",
          )}
        />
        {awaitsPayouts(profile) ? <PayoutSetupCard testID="verification-payouts" /> : null}
      </>
    );
  }

  return (
    <>
      <Message
        title={t(`proVerification.${status}.title`)}
        body={t(`proVerification.${status}.body`)}
      />
      {status === "rejected" ? (
        <>
          <ProfileReason reason={profile.rejection_reason} />
          <Reasons
            documents={documents.data}
            failed={documentsError !== null}
            busy={documents.isFetching}
            onRetry={() => void documents.refetch()}
          />
        </>
      ) : null}
      {/* The fix first: on a short screen it stays in sight under the reasons. */}
      {status === "rejected" ? (
        <Button
          label={t("proVerification.rejected.fix")}
          size="lg"
          onPress={() => push(DOCUMENTS)}
          testID="verification-fix"
        />
      ) : null}
      <ListGroup testID="verification-information">
        <ListRow
          label={t("proVerification.information.profile")}
          glyph={ACCOUNT_GLYPHS.proProfile}
          value={profileValue(t, profile)}
          onPress={() => push("/pro/profile")}
          testID="verification-profile"
        />
        <ListRow
          label={t("proVerification.information.documents")}
          glyph={ACCOUNT_GLYPHS.proDocuments}
          // How many are in once the list is known; nothing in its place while it loads or failed.
          value={documents.data ? documentsValue(t, documents.data) : undefined}
          onPress={() => push(DOCUMENTS)}
          testID="verification-documents"
        />
      </ListGroup>
    </>
  );
}

function profileValue(t: TFunction, profile: ProProfile): string {
  const { done, steps, complete } = profileChecklist(profile);
  return complete
    ? t("proVerification.information.profileComplete")
    : t("proProfile.checklist.progress", { done, total: steps.length });
}

function documentsValue(t: TFunction, data: MyDocuments): string {
  const { sent, rows, complete } = documentsChecklist(data);
  return complete
    ? t("proVerification.information.documentsComplete")
    : t("proVerification.documents.progress", { sent, total: rows.length });
}

/** One headline and one supporting line. */
function Message({ title, body }: { title: string; body: string }) {
  return (
    <View className="gap-1" testID="verification-message">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {title}
      </Text>
      <Text className="text-callout text-gray-500">{body}</Text>
    </View>
  );
}

/**
 * Why the team rejected the profile (`rejection_reason` on GET /v1/pros/me). Staff wrote it and
 * the API masked any contact details in it, so it is shown as it came, as plain read-only text
 * (never parsed, no field look). Without one, a calm line says none was given: nothing is made up.
 * Read as one element: the label, then the reason.
 */
function ProfileReason({ reason }: { reason: string | null }) {
  const { t } = useTranslation();
  const given = reason?.trim();
  return (
    <View accessible className="gap-1" testID="verification-profile-reason">
      <Text className="text-footnote text-gray-500">
        {t("proVerification.rejected.reasonLabel")}
      </Text>
      <Text className={given ? "text-body text-navy-900" : "text-body text-gray-500"}>
        {given || t("proVerification.rejected.noReason")}
      </Text>
    </View>
  );
}

type ReasonsProps = {
  documents: MyDocuments | undefined;
  failed: boolean;
  busy: boolean;
  onRetry: () => void;
};

/**
 * Why the review refused: each rejected document with the reason staff gave (plain text, never
 * parsed). With none rejected, nothing is listed: the line above already says what to do.
 */
function Reasons({ documents, failed, busy, onRetry }: ReasonsProps) {
  const { t } = useTranslation();
  if (documents === undefined) {
    return failed ? (
      <RetryNotice
        message={t("proVerification.documents.loadFailed")}
        action={t("proVerification.retry")}
        onRetry={onRetry}
        busy={busy}
        testID="verification-reasons-error"
      />
    ) : (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("proDocuments.loading")}
        testID="verification-reasons-loading"
      >
        <TextSkeleton type="callout" width="80%" />
      </View>
    );
  }
  const rejected = rejectedDocuments(documents);
  if (rejected.length === 0) return null;
  return (
    <View className="gap-3" testID="verification-reasons">
      {rejected.map(({ type, document }) => (
        <Notice
          key={type}
          tone="danger"
          title={t(`proDocuments.types.${type}`)}
          body={document?.rejection_reason?.trim() || t("proDocuments.rejected.noReason")}
          testID={`verification-reason-${type}`}
        />
      ))}
    </View>
  );
}
