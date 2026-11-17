import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { NetworkError } from "@/api";
import {
  Button,
  Card,
  Notice,
  Screen,
  StatusBadge,
  StatusBadgeSkeleton,
  TextSkeleton,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";

import { useMyDocuments } from "./api";
import { documentRows, type DocumentRow } from "./documents";
import { documentFacts, STATE_TONE } from "./format";

const ACCOUNT = "/account";
/** How many rows the skeleton draws: the two types every pro sends. */
const PLACEHOLDER_ROWS = 2;

// Shown to sighted users only: the row's label already says it all.
const VISUAL_ONLY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** One type as a white bubble that opens it: its name, its state as a pill, then its facts. */
function Row({ row, onPress }: { row: DocumentRow; onPress: () => void }) {
  const { t } = useTranslation();
  const name = t(`proDocuments.types.${row.type}`);
  const status = t(`proDocuments.status.${row.state}`);
  const facts = documentFacts(t, row);
  const hint = row.state === "missing" ? t(`proDocuments.hints.${row.type}`) : undefined;
  const testID = `pro-document-${row.type}`;

  return (
    <Card
      onPress={onPress}
      // Read as sentences: a reason that ends in a period does not get a second one.
      accessibilityLabel={[t("proDocuments.row", { name, status }), ...facts]
        .map((part) => part.replace(/[.\s]+$/, ""))
        .join(". ")}
      testID={testID}
    >
      <View {...VISUAL_ONLY} className="gap-2">
        <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <Text className="shrink text-headline text-navy-900">{name}</Text>
          <StatusBadge label={status} tone={STATE_TONE[row.state]} testID={`${testID}-status`} />
        </View>
        {hint ? <Text className="text-callout text-gray-500">{hint}</Text> : null}
        {facts.map((fact) => (
          // Staff wrote the reason: plain text only, never parsed.
          <Text key={fact} className="text-callout text-navy-900">
            {fact}
          </Text>
        ))}
      </View>
    </Card>
  );
}

/** A row-shaped placeholder: the name beside a pill, a line under them. */
function RowSkeleton() {
  const { t } = useTranslation();
  return (
    <Card>
      <View className="gap-2">
        <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <TextSkeleton type="headline" width="40%" />
          <StatusBadgeSkeleton label={t("proDocuments.status.missing")} />
        </View>
        <TextSkeleton type="callout" width="70%" />
      </View>
    </Card>
  );
}

/**
 * The pro's verification documents (#37): the types the API requires (and any other the pro
 * sent), each with where it stands: Missing, In review, Approved, or Rejected with the reason.
 * A row opens its type, to send a photo of it or replace the one in review.
 */
export function ProDocumentsScreen() {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch } = useMyDocuments();
  const shownError = useSettledError(data, error);
  const push = useGuardedPush();

  let content: ReactNode;
  if (data !== undefined) {
    content = (
      <>
        {/* A refresh that failed over rows on screen: they stay, and the pro can ask again. */}
        {error ? (
          <Notice tone="info" title={t("proDocuments.refreshFailed")} testID="pro-documents-stale">
            <Button
              label={t("proDocuments.retry")}
              variant="secondary"
              loading={isFetching}
              onPress={() => void refetch()}
              testID="pro-documents-refresh"
            />
          </Notice>
        ) : null}
        {documentRows(data).map((row) => (
          <Row
            key={row.type}
            row={row}
            onPress={() => push({ pathname: "/pro/documents/[type]", params: { type: row.type } })}
          />
        ))}
      </>
    );
  } else if (shownError !== null) {
    content = (
      <Notice
        tone="info"
        title={t("proDocuments.loadFailed")}
        body={t(
          shownError instanceof NetworkError ? "proDocuments.offline" : "proDocuments.loadBody",
        )}
        testID="pro-documents-load-failed"
      >
        <Button
          label={t("proDocuments.retry")}
          variant="secondary"
          loading={isFetching}
          onPress={() => void refetch()}
          testID="pro-documents-retry"
        />
      </Notice>
    );
  } else {
    content = (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("proDocuments.loading")}
        testID="pro-documents-loading"
      >
        <View {...VISUAL_ONLY} className="gap-3">
          {Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => (
            <RowSkeleton key={index} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <Screen bar="light" testID="pro-documents-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref={ACCOUNT} />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("proDocuments.title")}
          </Text>
          <Text className="text-callout text-gray-500">{t("proDocuments.support")}</Text>
        </View>
        <View className="gap-3">{content}</View>
      </ScrollView>
    </Screen>
  );
}
