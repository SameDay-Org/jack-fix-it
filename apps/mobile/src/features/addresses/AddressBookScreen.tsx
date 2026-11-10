import { Redirect, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { useSession } from "@/api";
import { ACCOUNT_GLYPHS } from "@/components/icons";
import {
  Button,
  IconTile,
  ListGroup,
  Notice,
  Screen,
  Skeleton,
  TextSkeleton,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { bubbleShadow, continuousCorners } from "@/theme";

import { useSavedAddresses, type SavedAddress } from "./api";
import { AddressRow } from "./AddressRow";

// Placeholder rows while the book loads: the most a first visit usually shows.
const SKELETON_ROWS = 2;
// The row tile's footprint (ListRow's 40 dp squircle).
const TILE_SIDE = 40;

/**
 * Account > Addresses: the customer's address book. The default comes first with its chip, then
 * the others; a row opens the address to edit and its dots open Make default and Delete. With none
 * saved, one friendly line and Add. A load failure says so and offers a retry; a failed refresh
 * keeps the book on screen. Only customers keep addresses: anyone else is sent back to Account.
 */
export function AddressBookScreen() {
  const role = useSession().user?.role;
  if (role !== "customer") return <Redirect href="/account" />;
  return <AddressBook />;
}

function AddressBook() {
  const { t } = useTranslation();
  const saved = useSavedAddresses();
  const items = saved.data?.items;

  const add = () => router.push("/account/addresses/new");
  const edit = (address: SavedAddress) =>
    router.push({ pathname: "/account/addresses/[id]", params: { id: address.id } });
  const openMenu = (address: SavedAddress) =>
    router.push({ pathname: "/account/addresses/[id]/actions", params: { id: address.id } });

  return (
    <Screen bar="light" testID="address-book-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref="/account" />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("addresses.title")}
          </Text>
          {items?.length ? (
            <Text className="text-callout text-gray-500">{t("addresses.support")}</Text>
          ) : null}
        </View>
        {items === undefined && saved.isPending ? <BookSkeleton /> : null}
        {items === undefined && saved.isError ? (
          <Notice tone="info" title={t("addresses.loadFailed")} testID="address-book-failed">
            <Button
              label={t("addresses.retry")}
              variant="secondary"
              loading={saved.isFetching}
              onPress={() => void saved.refetch()}
              testID="address-book-retry"
            />
          </Notice>
        ) : null}
        {items?.length === 0 ? <EmptyBook onAdd={add} /> : null}
        {items?.length ? (
          <>
            <ListGroup testID="address-book-list">
              {items.map((address) => (
                <AddressRow
                  key={address.id}
                  address={address}
                  glyph={ACCOUNT_GLYPHS.addresses}
                  onEdit={() => edit(address)}
                  onMore={() => openMenu(address)}
                />
              ))}
            </ListGroup>
            <Button
              label={t("addresses.add")}
              glyph="plus"
              variant="secondary"
              size="lg"
              onPress={add}
              testID="address-book-add"
            />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** The whole screen for the one message an empty book has: what it is for, and Add. */
function EmptyBook({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center gap-6 pb-12" testID="address-book-empty">
      <IconTile slug="" glyph={ACCOUNT_GLYPHS.addresses} size="lg" />
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-center text-title-2 text-navy-900">
          {t("addresses.empty.title")}
        </Text>
        <Text className="text-center text-callout text-gray-500">{t("addresses.empty.body")}</Text>
      </View>
      <Button
        label={t("addresses.add")}
        glyph="plus"
        size="lg"
        onPress={onAdd}
        className="self-stretch"
        testID="address-book-add"
      />
    </View>
  );
}

/** Rows shaped like the book's (tile, name, address line) while it loads. */
function BookSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("common.loading")}
      className="rounded-lg bg-white"
      style={[bubbleShadow, continuousCorners]}
      testID="address-book-loading"
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <View key={index} className="min-h-14 flex-row items-center gap-3 px-4 py-3">
          <Skeleton width={TILE_SIDE} height={TILE_SIDE} radius="sm" />
          <View className="flex-1 gap-1">
            <TextSkeleton type="body" width="40%" />
            <TextSkeleton type="callout" width="85%" />
          </View>
        </View>
      ))}
    </View>
  );
}
