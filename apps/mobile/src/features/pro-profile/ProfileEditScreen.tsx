import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NetworkError, useSession } from "@/api";
import {
  Button,
  ChipSkeleton,
  Input,
  Notice,
  Screen,
  Skeleton,
  TextSkeleton,
} from "@/components/ui";
import { fullName } from "@/features/account/identity";
import { backToPrevious, BackButton } from "@/features/auth/components/BackButton";
import { useCategories, type Category } from "@/features/home/useCategories";
import { lengthCounter } from "@/features/request/counter";

import { useMyProProfile, useServiceAreas, type ProProfile, type ServiceRegion } from "./api";
import { BIO_MAX, YEARS_MAX } from "./config";
import { areaIdsOf, draftErrors, draftOf } from "./draft";
import { PhotoField } from "./PhotoField";
import { AreaChoices, CategoryChoices } from "./ProfileChoices";
import { useProfileEditor } from "./useProfileEditor";

const HOME = "/";
/** The skeleton's chips, as wide as a few category names and ZIP codes at font scale 1. */
const CHIP_PLACEHOLDERS = [72, 96, 64, 88];
const PHOTO_SIDE = 72;
const YEARS_DIGITS = String(YEARS_MAX).length;

/**
 * The pro's profile, to fill in or change (#36): the photo, the bio, the years, the categories
 * and the service ZIP codes. It waits for the profile and the two catalogs; one that did not
 * load says so with a retry.
 */
export function ProProfileEditScreen() {
  const { t } = useTranslation();
  const profile = useMyProProfile();
  const categories = useCategories();
  const areas = useServiceAreas();
  const queries = [profile, categories, areas];
  const failed = queries.filter((query) => query.isError);

  if (profile.data && categories.data && areas.data) {
    return <Editor profile={profile.data} categories={categories.data} regions={areas.data} />;
  }
  return (
    <Shell>
      {failed.length > 0 ? (
        <Notice
          tone="info"
          title={t("proProfile.edit.loadFailed")}
          body={t(
            failed.some((query) => query.error instanceof NetworkError)
              ? "proProfile.edit.failed.offline"
              : "proProfile.edit.loadBody",
          )}
          testID="pro-profile-load-failed"
        >
          <Button
            label={t("proProfile.edit.retry")}
            variant="secondary"
            loading={queries.some((query) => query.isFetching)}
            onPress={() => failed.forEach((query) => void query.refetch())}
            testID="pro-profile-retry"
          />
        </Notice>
      ) : (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t("proProfile.edit.loading")}
          className="gap-6"
          testID="pro-profile-loading"
        >
          <View className="flex-row items-center gap-4">
            <Skeleton circle height={PHOTO_SIDE} />
            <View className="flex-1 gap-1">
              <TextSkeleton type="headline" width="50%" />
              <TextSkeleton type="footnote" width="80%" />
            </View>
          </View>
          <TextSkeleton type="headline" width="40%" />
          <Skeleton height={PHOTO_SIDE * 2} radius="lg" />
          <TextSkeleton type="headline" width="40%" />
          <View className="flex-row flex-wrap gap-2">
            {CHIP_PLACEHOLDERS.map((width) => (
              <ChipSkeleton key={width} labelWidth={width} />
            ))}
          </View>
        </View>
      )}
    </Shell>
  );
}

/** The screen's frame while there is no form: Back, the title, and what goes under them. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <Screen bar="light" testID="pro-profile-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <Heading />
        {children}
      </ScrollView>
    </Screen>
  );
}

function Heading() {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <BackButton fallbackHref={HOME} />
      <Text accessibilityRole="header" className="text-title-1 text-navy-900">
        {t("proProfile.edit.title")}
      </Text>
      <Text className="text-callout text-gray-500">{t("proProfile.edit.support")}</Text>
    </View>
  );
}

type EditorProps = {
  profile: ProProfile;
  categories: readonly Category[];
  regions: readonly ServiceRegion[];
};

function Editor({ profile, categories, regions }: EditorProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { user } = useSession();
  const offered = useMemo(
    () => ({ categoryIds: categories.map(({ id }) => id), areaIds: areaIdsOf(regions) }),
    [categories, regions],
  );
  // The form starts from the profile it opened with, whatever a refresh brings.
  const [initial] = useState(() => draftOf(profile, offered));
  const editor = useProfileEditor({ initial, offered, onSaved: () => backToPrevious(HOME) });
  const { draft, photo, errors, saving } = editor;
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Where the two parts Save can refuse start in the list, to bring the first one into view.
  const offsets = useRef({ about: 0, areas: 0 });

  const save = () => {
    const invalid = draftErrors(draft);
    const part = invalid.years ? "about" : invalid.areas ? "areas" : null;
    if (part) scroll.current?.scrollTo({ y: offsets.current[part], animated: !reduceMotion });
    void editor.submit();
  };

  return (
    <Screen bar="light" testID="pro-profile-screen">
      <KeyboardAvoidingView
        // Padding on both platforms, offset by the status bar `Screen` starts below: the app
        // draws edge to edge on Android.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          ref={scroll}
          contentContainerClassName="gap-6 px-4 pb-6 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Heading />
          <PhotoField
            photo={photo}
            saved={profile.photo}
            name={(user && fullName(user)) ?? t("proProfile.photo.title")}
            disabled={saving}
          />
          <View
            className="gap-3"
            onLayout={({ nativeEvent }) => (offsets.current.about = nativeEvent.layout.y)}
          >
            <Text accessibilityRole="header" className="text-headline text-navy-900">
              {t("proProfile.about.title")}
            </Text>
            <Input
              label={t("proProfile.about.bio")}
              hint={t("proProfile.about.bioHint")}
              value={draft.bio}
              onChangeText={editor.setBio}
              disabled={saving}
              multiline
              maxLength={BIO_MAX}
              counter={lengthCounter(t, draft.bio.length, BIO_MAX)}
              autoCapitalize="sentences"
              testID="pro-profile-bio"
            />
            <Input
              label={t("proProfile.about.years")}
              value={draft.years}
              onChangeText={editor.setYears}
              error={
                errors.years ? t("proProfile.about.yearsInvalid", { max: YEARS_MAX }) : undefined
              }
              disabled={saving}
              keyboardType="number-pad"
              maxLength={YEARS_DIGITS}
              testID="pro-profile-years"
            />
          </View>
          <CategoryChoices
            categories={categories}
            selected={draft.categoryIds}
            full={editor.categoriesFull}
            disabled={saving}
            onToggle={editor.toggleCategory}
          />
          <View onLayout={({ nativeEvent }) => (offsets.current.areas = nativeEvent.layout.y)}>
            <AreaChoices
              regions={regions}
              selected={draft.areaIds}
              full={editor.areasFull}
              disabled={saving}
              required={errors.areas === "required"}
              onToggle={editor.toggleArea}
              onToggleCity={editor.toggleCity}
              cityFits={editor.areasFit}
            />
          </View>
        </ScrollView>
        {/* Under the list, not in it: Save stays in reach however long the ZIP codes run. Opaque
            and drawn over the scroll view, as the request flow's action is: Android draws a
            scroll view's content past its frame. */}
        <View className="z-10 gap-3 bg-gray-50 px-4 pb-4 pt-2">
          {editor.failure ? (
            <Notice
              tone="danger"
              title={t(`proProfile.edit.failed.${editor.failure}`)}
              testID="pro-profile-failure"
            />
          ) : null}
          <Button
            label={t("proProfile.edit.save")}
            size="lg"
            loading={saving}
            disabled={photo.busy || photo.choosing}
            onPress={save}
            testID="pro-profile-save"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
