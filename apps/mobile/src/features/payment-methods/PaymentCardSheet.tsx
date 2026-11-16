import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { CardFace, stackTone } from "./CardFace";
import { shortSpokenCard, type Wallet } from "./cards";

/**
 * A saved card, opened: a sheet route presented with `sheetOptions("fitToContents")`. It shows
 * the card with its data redacted (brand, last four digits, expiry) and offers Set as default
 * (unless it is already) and Delete, which asks first. Either one closes the sheet at once; the
 * wallet shows the change while the server answers, and says so if it did not stick. While
 * another change of the wallet is unanswered, or the wallet is being listed after one, both wait:
 * who is the default may be moving. Whether this card is the default follows the wallet (the server
 * may name it while the sheet is open); once the sheet acts it holds what it showed and its actions
 * stay off, so it never redraws, nor acts twice, as it closes over its own change.
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
  // The wallet as this sheet reads it: the cache's (the observer follows it even when it fetches
  // nothing) until the sheet acts, then as it was at that moment.
  const [held, setHeld] = useState<Wallet | null>(null);
  const now = held ?? wallet.data ?? listed;
  const acted = held !== null;
  // The newest reading, for what runs after the render that drew it: the Delete dialog's confirm,
  // and the hold taken as the sheet leaves.
  const latest = useRef(now);
  useLayoutEffect(() => {
    latest.current = now;
  });
  // A change unanswered, or the list fetched after one still on its way (the observer shares the
  // query's fetch, even though it never fetches itself).
  const settling = useWalletBusy() || wallet.isFetching;
  const setDefault = useSetDefaultCard();
  const deleteCard = useDeleteCard();
  // One question at a time: a second quick tap would stack a second dialog on Android.
  const asking = useRef(false);
  // The sheet closes once, whichever of its actions asks first.
  const left = useRef(false);
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    setHeld(latest.current ?? []);
    router.back();
  }, []);

  // Its card is not in the wallet (a stale link), or the wallet could not load: nothing to show.
  useEffect(() => {
    if (missing) leave();
  }, [leave, missing]);

  if (!listed || !card) return null;
  // The card as the wallet has it now; the one first opened when it has left the wallet.
  const shown = now?.some((saved) => saved.id === id) ? now : listed;
  const current = shown.find((saved) => saved.id === id) ?? card;
  const spoken = shortSpokenCard(t, current);
  // Who is the default next is the server's choice: no card is named. When the wallet could not be
  // listed again and names no default, this card may be it: the dialog says so, as a maybe.
  const others = shown.length > 1;
  const defaultUnknown = wallet.isError && !shown.some((saved) => saved.is_default) && others;
  const deleteBody =
    current.is_default && others
      ? "paymentMethods.delete.bodyNextDefault"
      : defaultUnknown
        ? "paymentMethods.delete.bodyMaybeNextDefault"
        : "paymentMethods.delete.body";

  const confirmDelete = () => {
    if (asking.current) return;
    asking.current = true;
    const answered = () => {
      asking.current = false;
    };
    Alert.alert(
      t("paymentMethods.delete.title", { card: spoken }),
      t(deleteBody),
      [
        { text: t("paymentMethods.delete.cancel"), style: "cancel", onPress: answered },
        {
          text: t("paymentMethods.delete.confirm"),
          style: "destructive",
          onPress: () => {
            answered();
            // The card as the wallet has it when the customer confirms, not when the dialog opened.
            const confirmed = latest.current?.find((saved) => saved.id === id) ?? current;
            if (deleteCard(confirmed)) leave();
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
          {current.is_default ? null : (
            <Button
              label={t("paymentMethods.card.setDefault")}
              size="lg"
              disabled={settling || acted}
              onPress={() => {
                if (setDefault(current)) leave();
              }}
              testID="payment-card-default"
            />
          )}
          <Button
            label={t("paymentMethods.card.delete")}
            accessibilityHint={t("paymentMethods.card.deleteHint")}
            variant="secondary"
            size="lg"
            disabled={settling || acted}
            onPress={confirmDelete}
            testID="payment-card-delete"
          />
        </View>
      }
    >
      {/* Room for the card's shadow inside the sheet's scrolling body. */}
      <View className="gap-3 px-1 pb-2 pt-1">
        <CardFace card={current} tone={stackTone(shown, card)} testID="payment-card-face" />
        {current.is_default ? (
          <Text className="text-callout text-navy-900" testID="payment-card-is-default">
            {t("paymentMethods.card.isDefault")}
          </Text>
        ) : null}
      </View>
    </SheetContent>
  );
}
