import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";

import { Button, SheetContent } from "@/components/ui";

import { useDeleteAddress, useMakeDefaultAddress, useSavedAddresses } from "./api";
import { addressLine } from "./addressFields";
import { withoutAddress } from "./book";

/**
 * An address's menu, rendered by a sheet route presented with `sheetOptions("fitToContents")`:
 * Make default (unless it is already) and Delete, which asks first. Either one closes the sheet at
 * once; the book shows the change while the server answers, and says so if it did not stick.
 */
export function AddressActionsSheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Read from the book on screen, never fetched here; kept as first shown, so the sheet never
  // changes under the customer's finger, nor as it closes over the change it asked for.
  const { data } = useSavedAddresses({ enabled: false });
  const [book] = useState(() => data?.items ?? []);
  const address = book.find((item) => item.id === id);
  const deleteAddress = useDeleteAddress();
  const makeDefault = useMakeDefaultAddress();
  // One question at a time: a second quick tap would stack a second dialog on Android.
  const asking = useRef(false);

  // Opened without its address in the book (a stale link): there is nothing to act on.
  useEffect(() => {
    if (!address) router.back();
  }, [address]);

  if (!address) return null;
  // Deleting the default moves it to the oldest other address, the next one listed.
  const nextDefault = address.is_default ? withoutAddress(book, address.id)[0] : undefined;

  const confirmDelete = () => {
    if (asking.current) return;
    asking.current = true;
    const answered = () => {
      asking.current = false;
    };
    Alert.alert(
      t("addresses.delete.title", { label: address.label }),
      nextDefault
        ? t("addresses.delete.bodyNextDefault", { label: nextDefault.label })
        : t("addresses.delete.body"),
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
