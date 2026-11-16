import { router, unstable_useIsNavigating } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { Button, Notice, Screen, Skeleton, TextSkeleton } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { useAddCard, usePaymentMethods, useWalletBusy } from "./api";
import { walletFailure, type SavedCard } from "./cards";
import { POCKET, STRIP, WalletPocket } from "./WalletPocket";

/**
 * Account > Payment methods: the customer's wallet. The pocket holds the saved cards, the default
 * in front and named on its face; "See all" brings every card out; a card opens to set it as the
 * default or delete it; Add a card opens Stripe's sheet. With none saved the pocket itself is the
 * Add button. A load failure says so and offers a retry; a failed refresh keeps the wallet on
 * screen. Customers only: the routes' layout sends anyone else back to Account (`CustomerOnly`).
 */
export function PaymentMethodsScreen() {
  const { t } = useTranslation();
  const wallet = usePaymentMethods();
  const cards = wallet.data;
  const busy = useWalletBusy();
  const { add, adding, failure } = useAddCard();
  const [expanded, setExpanded] = useState(false);

  const open = useOpenCard();
  const loadFailure = cards === undefined && wallet.isError ? walletFailure(wallet.error) : null;
  // The wallet is on screen, but the last try to list it again failed: it may be out of date.
  const stale = cards !== undefined && wallet.isError;

  return (
    <Screen bar="light" testID="payment-methods-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref="/account" />
          <Text accessibilityRole="header" className="text-title-1 text-navy-900">
            {t("paymentMethods.title")}
          </Text>
          {cards ? (
            <Text className="text-callout text-gray-500" testID="payment-methods-support">
              {t(cards.length ? "paymentMethods.support" : "paymentMethods.emptySupport")}
            </Text>
          ) : null}
          {cards === undefined && wallet.isPending ? (
            <TextSkeleton type="callout" sample={t("paymentMethods.support")} />
          ) : null}
        </View>
        {stale ? (
          <Notice
            tone="info"
            title={t("paymentMethods.refreshFailed")}
            testID="payment-methods-stale"
          >
            <Button
              label={t("paymentMethods.retry")}
              variant="secondary"
              loading={wallet.isFetching}
              onPress={() => void wallet.refetch()}
              testID="payment-methods-refresh"
            />
          </Notice>
        ) : null}
        {cards === undefined && wallet.isPending ? <WalletSkeleton /> : null}
        {loadFailure ? (
          <Notice
            tone="info"
            title={t(
              loadFailure === "offline" || loadFailure === "unavailable"
                ? `paymentMethods.loadFailed.${loadFailure}`
                : "paymentMethods.loadFailed.generic",
            )}
            testID="payment-methods-failed"
          >
            <Button
              label={t("paymentMethods.retry")}
              variant="secondary"
              loading={wallet.isFetching}
              onPress={() => void wallet.refetch()}
              testID="payment-methods-retry"
            />
          </Notice>
        ) : null}
        {cards ? (
          <>
            <WalletPocket
              wallet={cards}
              expanded={expanded}
              onToggle={() => setExpanded((now) => !now)}
              onOpen={open}
              onAdd={add}
              adding={adding}
              locked={busy && !adding}
              settling={busy || wallet.isFetching}
              stale={stale}
            />
            {failure ? (
              <Notice
                tone="info"
                title={t(`paymentMethods.add.failure.${failure}.title`)}
                body={t(`paymentMethods.add.failure.${failure}.body`)}
                testID="payment-methods-add-failed"
              />
            ) : null}
            {cards.length ? (
              <Button
                label={t("paymentMethods.add.label")}
                variant="secondary"
                size="lg"
                loading={adding}
                disabled={busy && !adding}
                onPress={add}
                testID="payment-methods-add"
              />
            ) : null}
            <Text className="text-center text-footnote text-gray-500">
              {t("paymentMethods.note")}
            </Text>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * Opens a card. A second tap before its sheet is up opens nothing: the router queues a push and
 * the wallet stays tappable until it lands. Once the router is idle again a card opens again.
 */
function useOpenCard() {
  const opening = useRef(false);
  const navigating = unstable_useIsNavigating();

  useEffect(() => {
    if (!navigating) opening.current = false;
  }, [navigating]);

  return useCallback((card: SavedCard) => {
    if (opening.current) return;
    opening.current = true;
    router.push({ pathname: "/account/payment-methods/[id]", params: { id: card.id } });
  }, []);
}

/**
 * The wallet's outline while it loads, as tall as a wallet of one card: the "See all" tab, a card
 * peeking out of the pocket and the pocket's front, one under the other, never overlaid (two
 * translucent shapes over each other would draw a darker band).
 */
function WalletSkeleton() {
  const { t } = useTranslation();
  return (
    <View accessible accessibilityLabel={t("common.loading")} testID="payment-methods-loading">
      <View className="w-2/3 self-center" testID="payment-methods-loading-tab">
        <Skeleton height={STRIP.peek + STRIP.tuck} radius="lg" />
      </View>
      {/* The inset on a wrapper: on the full-width shape itself it would push it past the edge. */}
      <View style={{ paddingHorizontal: STRIP.inset }}>
        <Skeleton height={STRIP.peek + STRIP.tuck} radius="lg" />
      </View>
      <Skeleton height={POCKET.minHeight - STRIP.tuck} radius="lg" />
    </View>
  );
}
