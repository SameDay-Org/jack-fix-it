import { useLocalSearchParams } from "expo-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { ApiError } from "@/api";
import {
  Button,
  Notice,
  Screen,
  ShareRender,
  Skeleton,
  TextSkeleton,
  type ShareHandle,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { jobHref } from "@/features/jobs/api";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useShareImage } from "@/features/share/useShareImage";

import { RECEIPT_NOT_AVAILABLE, useReceipt } from "./api";
import { ReceiptPaper } from "./ReceiptPaper";

/** The shared image's design width in dp (the PNG is 3x or more). */
const SHARE_WIDTH = 360;
/** The private cache folder the shared PNGs go to. */
const SHARE_DIR = "receipt-share";
/** Lines in the placeholder, shaped like the paper's. */
const SKELETON_LINES = 6;

/**
 * The receipt of a request's job (#62), from the moment its payment went through: the paper,
 * then Share (an image, without the address, Q-R2/Q-R5) and, while a tip can still be added, the
 * way to it on the job (#273). Loading shows the paper's shape; a receipt not there yet, an error
 * or no connection say so calmly.
 */
export function ReceiptScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: receipt, error, isFetching, refetch } = useReceipt(id);
  const shareRender = useRef<ShareHandle>(null);
  const { sharing, share } = useShareImage(shareRender, {
    dialogTitle: t("receipt.shareDialog"),
    failed: t("receipt.shareFailed"),
  });
  const push = useGuardedPush();
  const notYet = error instanceof ApiError && error.code === RECEIPT_NOT_AVAILABLE;

  return (
    <Screen bar="light" testID="receipt-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-8 pt-2">
        <BackButton fallbackHref={jobHref(id)} />
        <Text accessibilityRole="header" className="text-title-1 text-navy-900">
          {t("receipt.title")}
        </Text>
        {receipt ? (
          <>
            <ReceiptPaper receipt={receipt} withAddress testID="receipt-paper" />
            <View className="gap-3">
              <Button
                label={t("receipt.share")}
                glyph="share"
                variant="secondary"
                loading={sharing}
                onPress={() => void share()}
                testID="receipt-share"
              />
              {receipt.tip?.can_tip ? (
                <Button
                  label={t("receipt.addTip")}
                  variant="ghost"
                  onPress={() => push(jobHref(id))}
                  testID="receipt-add-tip"
                />
              ) : null}
            </View>
            <ShareRender
              ref={shareRender}
              baseWidth={SHARE_WIDTH}
              dirName={SHARE_DIR}
              prefix="receipt"
              testID="receipt-share-render"
            >
              {() => (
                <View className="bg-gray-50 p-4">
                  <ReceiptPaper receipt={receipt} withAddress={false} />
                </View>
              )}
            </ShareRender>
          </>
        ) : notYet ? (
          <Notice tone="info" title={t("receipt.notYet")} testID="receipt-not-yet" />
        ) : error ? (
          <RetryNotice
            message={t("receipt.error.title")}
            action={t("receipt.error.retry")}
            onRetry={() => void refetch()}
            busy={isFetching}
            testID="receipt-error"
          />
        ) : (
          <ReceiptSkeleton />
        )}
      </ScrollView>
    </Screen>
  );
}

/** The paper's shape while the receipt loads, read as one "Loading your receipt". */
function ReceiptSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("receipt.loading")}
      testID="receipt-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-5 bg-white px-5 py-6"
      >
        <View className="items-center gap-2">
          <Skeleton className="h-1 w-12" />
          <TextSkeleton type="title-2" width="50%" />
          <TextSkeleton type="footnote" width="40%" />
        </View>
        {Array.from({ length: SKELETON_LINES }, (_, index) => (
          <View key={index} className="flex-row justify-between gap-3">
            <TextSkeleton type="callout" width="55%" />
            <TextSkeleton type="callout" width="20%" />
          </View>
        ))}
      </View>
    </View>
  );
}
