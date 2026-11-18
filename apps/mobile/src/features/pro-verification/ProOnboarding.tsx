import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, View } from "react-native";

import { NetworkError, useSessionGeneration } from "@/api";
import { Card, ChecklistCardSkeleton, TextSkeleton } from "@/components/ui";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { PayoutSetupCard } from "@/features/payouts";
import { myDocumentsQueryKey } from "@/features/pro-documents/api";
import { profileChecklist, ProfileChecklistCard, type ProProfile } from "@/features/pro-profile";
import { PROFILE_STEPS } from "@/features/pro-profile/completeness";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import { DocumentsChecklistCard } from "./DocumentsChecklistCard";
import { awaitsPayouts } from "./verification";
import { VerificationBanner } from "./VerificationBanner";

export type ProOnboardingProps = {
  /** The profile, when it is known: a pro who is not approved, or approved without payouts. */
  profile: ProProfile | undefined;
  /** Why the profile is not known. */
  error: unknown;
  /** The profile is being asked for (again). */
  loading: boolean;
  onRetry: () => void;
  /** Asked again on a pull, with the documents: the profile, and whatever else the home shows. */
  onRefresh: () => Promise<unknown>;
  /** Scrolls above everything: the home's greeting. */
  header: ReactNode;
  /** Scrolls under the checklists: what the home shows whatever the status (the pro's jobs). */
  children?: ReactNode;
  testID?: string;
};

/**
 * The pro's home until the pro is approved and can be paid (#38), in place of the new requests:
 * where the review stands, then what is left to do: "Finish your profile" and "Send your
 * documents", each gone once done, or, once approved, "Finish payout setup", which opens the
 * payout screen (#277). No request is listed, and none is asked for. While the profile is not
 * known the home draws the shape of this (never a list that might not apply), and a profile that
 * did not load says so with a retry.
 */
export function ProOnboarding({
  profile,
  error,
  loading,
  onRetry,
  onRefresh,
  header,
  children,
  testID = "pro-onboarding",
}: ProOnboardingProps) {
  const { t } = useTranslation();
  const shownError = useSettledError(profile, error);
  const client = useQueryClient();
  const generation = useSessionGeneration();
  const [pulling, setPulling] = useState(false);

  const refresh = async () => {
    setPulling(true);
    try {
      // The documents with the rest: a review may have rejected one since the home opened.
      await Promise.all([
        onRefresh(),
        client.refetchQueries({ queryKey: myDocumentsQueryKey(generation) }),
      ]);
    } finally {
      setPulling(false);
    }
  };

  return (
    <ScrollView
      contentContainerClassName="gap-6 px-4 pb-6 pt-2"
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => void refresh()}
          tintColor={tokens.colors["navy-900"]}
          colors={[tokens.colors["navy-900"]]}
        />
      }
      testID={testID}
    >
      {header}
      {profile !== undefined ? (
        <>
          <VerificationBanner profile={profile} />
          <ProfileChecklistCard />
          {awaitsPayouts(profile) ? (
            // The review is over: what is left is payout setup. One primary action on the home:
            // the profile's while it is shown, then this one.
            <PayoutSetupCard primary={profileChecklist(profile).complete} />
          ) : (
            // One primary action on the home: the profile's while it is shown, then this one.
            <DocumentsChecklistCard primary={profileChecklist(profile).complete} />
          )}
        </>
      ) : shownError !== null ? (
        <RetryNotice
          message={t(
            shownError instanceof NetworkError
              ? "proVerification.home.offline"
              : "proVerification.home.loadFailed",
          )}
          action={t("proVerification.retry")}
          onRetry={onRetry}
          busy={loading}
          testID={`${testID}-error`}
        />
      ) : (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t("proVerification.home.loading")}
          className="gap-6"
          testID={`${testID}-loading`}
        >
          <Card>
            <View className="gap-2">
              <TextSkeleton type="headline" width="45%" />
              <TextSkeleton type="callout" width="85%" />
            </View>
          </Card>
          <ChecklistCardSkeleton steps={PROFILE_STEPS.length} />
        </View>
      )}
      {children}
    </ScrollView>
  );
}
