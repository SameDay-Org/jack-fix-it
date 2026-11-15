import { Redirect, useLocalSearchParams } from "expo-router";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NetworkError } from "@/api";
import {
  Button,
  Card,
  Input,
  Notice,
  ProgressRing,
  Screen,
  Skeleton,
  StatusBadge,
  TextSkeleton,
} from "@/components/ui";
import { backToPrevious, BackButton } from "@/features/auth/components/BackButton";
import {
  FrameGlyph,
  MediaPermissionNotice,
  singlePhotoStatus,
  useStableImageUri,
  type SinglePhoto,
} from "@/features/media";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { continuousCorners } from "@/theme";

import { useMyDocuments } from "./api";
import {
  documentRow,
  isDocumentType,
  takesExpiry,
  type DocumentRow,
  type DocumentType,
  type ProDocument,
} from "./documents";
import { formatDay, STATE_TONE } from "./format";
import { useDocumentSubmit } from "./useDocumentSubmit";

const LIST = "/pro/documents";
/** The photo's frame: as wide as the bubble and low, so what is under it stays in sight on a short screen. */
const PHOTO_ASPECT = 16 / 9;
const PHOTO_PLACEHOLDER_HEIGHT = 192;
/** "MM/DD/YYYY" */
const DATE_LENGTH = 10;

/**
 * One document type (`/pro/documents/<type>`): where it stands, then a photo of it to send
 * (the first one, a new one after a rejection, or one that replaces the one in review), with an
 * expiry date for a license or an insurance policy. A type the API does not know goes to the list.
 */
export function DocumentScreen() {
  const { t } = useTranslation();
  const { type } = useLocalSearchParams<{ type: string }>();
  const { data, error, isFetching, refetch } = useMyDocuments();
  const shownError = useSettledError(data, error);

  if (!isDocumentType(type)) return <Redirect href={LIST} />;
  if (data !== undefined) return <Submitter key={type} row={documentRow(data, type)} />;
  return (
    <Screen bar="light" testID="pro-document-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <Heading type={type} />
        {shownError !== null ? (
          <Notice
            tone="info"
            title={t("proDocuments.loadFailed")}
            body={t(
              shownError instanceof NetworkError ? "proDocuments.offline" : "proDocuments.loadBody",
            )}
            testID="pro-document-load-failed"
          >
            <Button
              label={t("proDocuments.retry")}
              variant="secondary"
              loading={isFetching}
              onPress={() => void refetch()}
              testID="pro-document-retry"
            />
          </Notice>
        ) : (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t("proDocuments.loading")}
            className="gap-4"
            testID="pro-document-loading"
          >
            <TextSkeleton type="callout" width="40%" />
            <Skeleton height={PHOTO_PLACEHOLDER_HEIGHT} radius="lg" />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function Heading({ type, children }: { type: DocumentType; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <BackButton fallbackHref={LIST} />
      <Text accessibilityRole="header" className="text-title-1 text-navy-900">
        {t(`proDocuments.types.${type}`)}
      </Text>
      <Text className="text-callout text-gray-500">{t(`proDocuments.hints.${type}`)}</Text>
      {children}
    </View>
  );
}

function Submitter({ row }: { row: DocumentRow }) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { type, state, document } = row;
  const form = useDocumentSubmit({ type, onSubmitted: () => backToPrevious(LIST) });
  const { photo, errors, submitting } = form;
  const reason = document?.rejection_reason?.trim();
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const send = () => {
    // With no photo to send, the photo's bubble says so: bring it into view.
    if (photo.key === null && !photo.busy) {
      scroll.current?.scrollTo({ y: 0, animated: !reduceMotion });
    }
    void form.submit();
  };
  const expiryMessage = errors.expiry
    ? t(`proDocuments.submit.expiryErrors.${errors.expiry}`)
    : undefined;

  return (
    <Screen bar="light" testID="pro-document-screen">
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={top} className="flex-1">
        <ScrollView
          ref={scroll}
          contentContainerClassName="gap-6 px-4 pb-6 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Heading type={type}>
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
              <StatusBadge
                label={t(`proDocuments.status.${state}`)}
                tone={STATE_TONE[state]}
                testID="pro-document-status"
              />
              {document?.expires_on ? (
                <Text className="text-footnote text-gray-500" testID="pro-document-expires">
                  {t("proDocuments.expires", { date: formatDay(document.expires_on) })}
                </Text>
              ) : null}
            </View>
          </Heading>
          {state === "rejected" ? (
            <Notice
              tone="danger"
              title={t("proDocuments.rejected.title")}
              // Staff wrote the reason: the notice draws it as plain text.
              body={reason || t("proDocuments.rejected.noReason")}
              testID="pro-document-rejected"
            />
          ) : state === "pending" ? (
            <Notice tone="info" title={t("proDocuments.pending")} testID="pro-document-pending" />
          ) : null}
          <PhotoBubble
            // A new document is a new picture: its frame starts over.
            key={document?.id ?? "none"}
            photo={photo}
            current={document}
            missing={errors.photo === "required"}
            disabled={submitting}
          />
          {takesExpiry(type) ? (
            <Input
              label={t("common.optionalLabel", { label: t("proDocuments.submit.expiry") })}
              hint={t("proDocuments.submit.expiryHint")}
              value={form.expiry}
              onChangeText={form.setExpiry}
              error={expiryMessage}
              disabled={submitting}
              keyboardType="number-pad"
              maxLength={DATE_LENGTH}
              testID="pro-document-expiry"
            />
          ) : null}
        </ScrollView>
        {/* Pinned, opaque and drawn over the scroll view, as the profile's Save is. */}
        <View className="z-10 gap-3 bg-gray-50 px-4 pb-4 pt-2">
          {form.failure ? (
            <Notice
              tone="danger"
              title={t(`proDocuments.submit.failed.${form.failure}`)}
              testID="pro-document-failure"
            />
          ) : null}
          <Button
            label={t(document ? "proDocuments.submit.replace" : "proDocuments.submit.send")}
            size="lg"
            loading={submitting}
            disabled={photo.busy || photo.choosing}
            onPress={send}
            testID="pro-document-submit"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

type PhotoBubbleProps = {
  photo: SinglePhoto;
  /** The document on file, whose picture shows until a new one is chosen. */
  current: ProDocument | undefined;
  /** Submit was pressed with no new photo. */
  missing: boolean;
  disabled: boolean;
};

/**
 * The document's photo: the new one once chosen, else the one on file (drawn from its signed
 * URL, which stays inside this image), and no frame while there is neither; what is happening
 * to it; and the button that asks "Camera or library".
 */
function PhotoBubble({ photo, current, missing, disabled }: PhotoBubbleProps) {
  const { t } = useTranslation();
  const savedUri = useStableImageUri(current);
  const uri = photo.previewUri ?? savedUri;
  const [failedUri, setFailedUri] = useState<string>();
  const shown = uri !== undefined && uri !== failedUri;
  const problem = photo.failure !== null || missing;
  const status =
    singlePhotoStatus(t, photo) ??
    t(
      photo.key
        ? "proDocuments.photo.ready"
        : missing
          ? "proDocuments.photo.required"
          : "proDocuments.photo.support",
    );

  return (
    <View className="gap-3">
      <Card testID="pro-document-photo">
        <View className="gap-3">
          {/* No picture, no frame: an empty one would push the button and its message off a
              short screen. */}
          {uri === undefined ? null : (
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={t(
                shown ? "proDocuments.photo.label" : "proDocuments.photo.unavailable",
              )}
              style={[continuousCorners, { aspectRatio: PHOTO_ASPECT }]}
              className="items-center justify-center overflow-hidden rounded-md bg-navy-900/10"
              testID="pro-document-photo-frame"
            >
              {shown ? (
                <Image
                  source={{ uri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode="contain"
                  onError={() => setFailedUri(uri)}
                  accessibilityIgnoresInvertColors
                  testID="pro-document-photo-image"
                />
              ) : (
                <FrameGlyph />
              )}
              {photo.busy ? (
                <View className="absolute inset-0 items-center justify-center bg-navy-900/40">
                  <ProgressRing
                    progress={photo.progress}
                    accessibilityLabel={t("proDocuments.photo.uploading")}
                  />
                </View>
              ) : null}
            </View>
          )}
          <Text
            accessibilityLiveRegion="polite"
            className={problem ? "text-footnote text-danger" : "text-footnote text-gray-500"}
            testID="pro-document-photo-status"
          >
            {status}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={t(uri ? "proDocuments.photo.change" : "proDocuments.photo.add")}
              variant="secondary"
              loading={photo.choosing}
              disabled={disabled || photo.busy}
              onPress={photo.choose}
              testID="pro-document-photo-choose"
            />
            {photo.canRetry ? (
              <Button
                label={t("proDocuments.photo.retry")}
                variant="ghost"
                disabled={disabled}
                onPress={photo.retry}
                testID="pro-document-photo-retry"
              />
            ) : null}
          </View>
        </View>
      </Card>
      {photo.permissionDenied ? (
        <MediaPermissionNotice onDismiss={photo.dismissPermissionNotice} />
      ) : null}
    </View>
  );
}
