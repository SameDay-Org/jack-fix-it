import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";

import { Button, SheetContent } from "@/components/ui";

import {
  SAVED_ADDRESSES_QUERY_KEY,
  useDeleteAddress,
  useMakeDefaultAddress,
  useSavedAddresses,
} from "./api";
import { addressLine } from "./addressFields";
import { nextDefaultAfter } from "./book";

/**
 * An address's menu, rendered by a sheet route presented with `sheetOptions("fitToContents")`:
 * Make default (unless it is already) and Delete, which asks first. Either one closes the sheet at
 * once; the book shows the change while the server answers, and says so if it did not stick.
 */
export function AddressActionsSheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Read from the book on screen; fetched here only when a link opened the sheet before the book
  // had loaded. Kept as first loaded, so the sheet never changes under the customer's finger, nor
  // as it closes over the change it asked for.
  const client = useQueryClient();
  const [cachedAtOpen] = useState(() => !!client.getQueryData(SAVED_ADDRESSES_QUERY_KEY));
  const saved = useSavedAddresses({ enabled: !cachedAtOpen });
  const [list, setList] = useState(saved.data);
  if (list === undefined && saved.data) setList(saved.data);
  const address = list?.items.find((item) => item.id === id);
  const missing = list === undefined ? saved.isError : !address;
  const deleteAddress = useDeleteAddress();
  const makeDefault = useMakeDefaultAddress();
  // One question at a time: a second quick tap would stack a second dialog on Android.
  const asking = useRef(false);

  // Its address is not in the book (a stale link), or the book could not load: nothing to act on.
  useEffect(() => {
    if (missing) router.back();
  }, [missing]);

  if (!list || !address) return null;
  // Deleting the default moves it to the oldest other address. It is named only when the device
  // can tell which one that is: a wrong name would be a promise the server does not keep.
  const movesDefault = address.is_default && list.items.length > 1;
  const nextDefault = movesDefault
    ? nextDefaultAfter(list.items, address.id, !list.redrawn)
    : undefined;
  const deleteBody = !movesDefault
    ? t("addresses.delete.body")
    : nextDefault
      ? t("addresses.delete.bodyNextDefault", { label: nextDefault.label })
      : t("addresses.delete.bodyNewDefault");

  const confirmDelete = () => {
    if (asking.current) return;
    asking.current = true;
    const answered = () => {
      asking.current = false;
    };
    Alert.alert(
      t("addresses.delete.title", { label: address.label }),
      deleteBody,
      [
        { text: t("addresses.delete.cancel"), style: "cancel", onPress: answered },
        {
          text: t("addresses.delete.confirm"),
          style: "destructive",
          onPress: () => {
            answered();
            deleteAddress(address);
            router.back();
          },
        },
      ],
      // Back or a tap outside closes it on Android, the same as Cancel.
      { cancelable: true, onDismiss: answered },
    );
  };

  return (
    <SheetContent
      title={address.label}
      fitToContents
      testID="address-actions-sheet"
      // Full width, one above the other: two pills never squeeze into a row on a narrow phone.
      actions={
        <View className="flex-1 gap-3">
          {address.is_default ? null : (
            <Button
              label={t("addresses.actions.makeDefault")}
              size="lg"
              onPress={() => {
                makeDefault(address);
                router.back();
              }}
              testID="address-actions-default"
            />
          )}
          <Button
            label={t("addresses.actions.delete")}
            accessibilityHint={t("addresses.actions.deleteHint")}
            variant="secondary"
            size="lg"
            onPress={confirmDelete}
            testID="address-actions-delete"
          />
        </View>
      }
    >
      <View className="gap-1">
        <Text className="text-callout text-gray-500">{addressLine(address)}</Text>
        {address.is_default ? (
          <Text className="text-callout text-navy-900" testID="address-actions-is-default">
            {t("addresses.actions.isDefault")}
          </Text>
        ) : null}
      </View>
    </SheetContent>
  );
}
