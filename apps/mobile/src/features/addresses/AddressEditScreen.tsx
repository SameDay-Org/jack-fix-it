import { Redirect, useLocalSearchParams } from "expo-router";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/api";
import { Button, Input, Notice, Screen, TextSkeleton, type InputHandle } from "@/components/ui";
import { backToPrevious, BackButton } from "@/features/auth/components/BackButton";

import { LABEL_MAX } from "./addressFields";
import { AddressForm } from "./AddressForm";
import { useSavedAddresses, type SavedAddress } from "./api";
import { useAddressEditor } from "./useAddressEditor";

const BOOK = "/account/addresses";

/** Account > Addresses > Add: a new address for the book. */
export function NewAddressScreen() {
  return (
    <CustomersOnly>
      <EditorRoute />
    </CustomersOnly>
  );
}

/** Account > Addresses > an address: its name and fields, to change. */
export function EditAddressScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <CustomersOnly>
      <EditorRoute id={id} />
    </CustomersOnly>
  );
}

function CustomersOnly({ children }: { children: ReactNode }) {
  const role = useSession().user?.role;
  return role === "customer" ? children : <Redirect href="/account" />;
}

/**
 * Waits for the book (the name check needs it, an edit needs its address), then the form. An id
 * the book does not hold (deleted on another device, an old link) says so, with the way back.
 */
function EditorRoute({ id }: { id?: string }) {
  const { t } = useTranslation();
  const saved = useSavedAddresses();
  const items = saved.data?.items;
  const address = id ? items?.find((item) => item.id === id) : undefined;
  const title = t(id ? "addresses.form.editTitle" : "addresses.form.newTitle");

  if (items === undefined) {
    return (
      <Shell title={title}>
        {saved.isError ? (
          <Notice tone="info" title={t("addresses.loadFailed")} testID="address-form-failed">
            <Button
              label={t("addresses.retry")}
              variant="secondary"
              loading={saved.isFetching}
              onPress={() => void saved.refetch()}
              testID="address-form-retry"
            />
          </Notice>
        ) : (
          <View
            accessible
            accessibilityLabel={t("common.loading")}
            className="gap-4"
            testID="address-form-loading"
          >
            <TextSkeleton type="callout" width="70%" />
            <TextSkeleton type="body" />
            <TextSkeleton type="body" />
          </View>
        )}
      </Shell>
    );
  }
  if (id && !address) {
    return (
      <Shell title={title}>
        <Notice tone="info" title={t("addresses.form.failed.gone")} testID="address-form-gone">
          <Button
            label={t("addresses.form.backToBook")}
            variant="secondary"
            onPress={() => backToPrevious(BOOK)}
            testID="address-form-back"
          />
        </Notice>
      </Shell>
    );
  }
  // Keyed by the address: the form starts from the one it opened with, whatever a refresh brings.
  return <Editor key={address?.id ?? "new"} title={title} address={address} book={items} />;
}

/** The screen's frame: Back, the title, and what goes under it. */
function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Screen bar="light" testID="address-form-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref={BOOK} />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {title}
          </Text>
        </View>
        {children}
      </ScrollView>
    </Screen>
  );
}

function Editor({
  title,
  address,
  book,
}: {
  title: string;
  address: SavedAddress | undefined;
  book: readonly SavedAddress[];
}) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const street = useRef<InputHandle>(null);
  const editor = useAddressEditor({ address, book, onSaved: () => backToPrevious(BOOK) });
  const submit = () => void editor.submit();
  const labelMessage = editor.labelError
    ? editor.labelError === "taken" || editor.labelError === "invalid"
      ? t(`addresses.form.labelErrors.${editor.labelError}`)
      : t(`address.errors.${editor.labelError}`, { max: LABEL_MAX })
    : undefined;

  return (
    <Screen bar="light" testID="address-form-screen">
      <KeyboardAvoidingView
        // Padding on both platforms, offset by the status bar `Screen` starts below (see
        // PhoneEntryScreen): the app draws edge to edge on Android.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View className="gap-2">
            <BackButton fallbackHref={BOOK} />
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {title}
            </Text>
            <Text className="text-callout text-gray-500">
              {t(address ? "addresses.form.editSupport" : "addresses.form.newSupport")}
            </Text>
          </View>
          <Input
            label={t("addresses.form.label")}
            value={editor.label}
            onChangeText={editor.setLabel}
            error={labelMessage}
            disabled={editor.saving}
            maxLength={LABEL_MAX}
            autoCapitalize="words"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => street.current?.focus()}
            testID="address-form-label"
          />
          <AddressForm
            ref={street}
            fields={editor.fields}
            errors={editor.errors}
            onChange={editor.setField}
            disabled={editor.saving}
            onSubmitEditing={submit}
            testID="address-form"
          />
          {editor.failure ? (
            <Notice
              tone="danger"
              title={t(`addresses.form.failed.${editor.failure}`)}
              testID="address-form-failure"
            />
          ) : null}
          <View className="flex-1" />
          <Button
            label={t("addresses.form.save")}
            size="lg"
            loading={editor.saving}
            onPress={submit}
            testID="address-form-save"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
