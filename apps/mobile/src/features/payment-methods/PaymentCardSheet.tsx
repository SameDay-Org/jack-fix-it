import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";

import { Button, SheetContent } from "@/components/ui";

import {
  PAYMENT_METHODS_QUERY_KEY,
  useDeleteCard,
  usePaymentMethods,
  useSetDefaultCard,
  useWalletBusy,
} from "./api";
import { CardFace, cardTone } from "./CardFace";
import { ageOf, shortSpokenCard } from "./cards";

/**
 * A saved card, opened: a sheet route presented with `sheetOptions("fitToContents")`. It shows
 * the card with its data redacted (brand, last four digits, expiry) and offers Set as default
 * (unless it is already) and Delete, which asks first. Either one closes the sheet at once; the
 * wallet shows the change while the server answers, and says so if it did not stick. While
 * another change of the wallet is unanswered both wait.
 */
export function PaymentCardSheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Read from the wallet on screen; fetched here only when a link opened the sheet before the
  // wallet had loaded. Kept as first loaded, so the card never changes under the customer's
  // finger, nor as the sheet closes over the change it asked for.
  const client = useQueryClient();
  const [cachedAtOpen] = useState(() => !!client.getQueryData(PAYMENT_METHODS_QUERY_KEY));
  const wallet = usePaymentMethods({ enabled: !cachedAtOpen });
  const [listed, setListed] = useState(wallet.data);
  if (listed === undefined && wallet.data) setListed(wallet.data);
  const card = listed?.find((saved) => saved.id === id);
  const missing = listed === undefined ? wallet.isError : !card;
  const busy = useWalletBusy();
  const setDefault = useSetDefaultCard();
  const deleteCard = useDeleteCard();
  // One question at a time: a second quick tap would stack a second dialog on Android.
  const asking = useRef(false);
  // The sheet closes once, whichever of its actions asks first.
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    router.back();
  }, []);

  // Its card is not in the wallet (a stale link), or the wallet could not load: nothing to show.
  useEffect(() => {
    if (missing) leave();
  }, [leave, missing]);

  if (!listed || !card) return null;
  const spoken = shortSpokenCard(t, card);
  // Who is the default next is the server's choice: no card is named.
  const movesDefault = card.is_default && listed.length > 1;

  const confirmDelete = () => {
    if (asking.current) return;
    asking.current = true;
    const answered = () => {
      asking.current = false;
    };
    Alert.alert(
      t("paymentMethods.delete.title", { card: spoken }),
      t(movesDefault ? "paymentMethods.delete.bodyNextDefault" : "paymentMethods.delete.body"),
      [
        { text: t("paymentMethods.delete.cancel"), style: "cancel", onPress: answered },
        {
          text: t("paymentMethods.delete.confirm"),
          style: "destructive",
          onPress: () => {
            answered();
            if (deleteCard(card)) leave();
          },
        },
      ],
      // Back or a tap outside closes it on Android, the same as Cancel.
      { cancelable: true, onDismiss: answered },
    );
  };

  return (
    <SheetContent
      fitToContents
      testID="payment-card-sheet"
      // Full width, one above the other: two pills never squeeze into a row on a narrow phone.
      actions={
        <View className="flex-1 gap-3">
          {card.is_default ? null : (
            <Button
              label={t("paymentMethods.card.setDefault")}
              size="lg"
              disabled={busy}
              onPress={() => {
                if (setDefault(card)) leave();
              }}
              testID="payment-card-default"
            />
          )}
          <Button
            label={t("paymentMethods.card.delete")}
            accessibilityHint={t("paymentMethods.card.deleteHint")}
            variant="secondary"
            size="lg"
            disabled={busy}
            onPress={confirmDelete}
            testID="payment-card-delete"
          />
        </View>
      }
    >
      {/* Room for the card's shadow inside the sheet's scrolling body. */}
      <View className="gap-3 px-1 pb-2 pt-1">
        <CardFace card={card} tone={cardTone(ageOf(listed, card))} testID="payment-card-face" />
        {card.is_default ? (
          <Text className="text-callout text-navy-900" testID="payment-card-is-default">
            {t("paymentMethods.card.isDefault")}
          </Text>
        ) : null}
      </View>
    </SheetContent>
  );
}
