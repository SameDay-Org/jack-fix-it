import { router } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { Button, Notice, Screen, Skeleton } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { useAddCard, usePaymentMethods, useWalletBusy } from "./api";
import { walletFailure, walletOrder, type SavedCard } from "./cards";
import { WalletPocket } from "./WalletPocket";

// The loading wallet's shapes: one card peeking out, and the pocket's front.
const SKELETON = { card: 72, tuck: 24, pocket: 152 } as const;

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
  const cards = useMemo(() => wallet.data && walletOrder(wallet.data), [wallet.data]);
  const busy = useWalletBusy();
  const { add, adding, failure } = useAddCard();
  const [expanded, setExpanded] = useState(false);

  const open = (card: SavedCard) =>
    router.push({ pathname: "/account/payment-methods/[id]", params: { id: card.id } });
  const loadFailure = cards === undefined && wallet.isError ? walletFailure(wallet.error) : null;

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
        </View>
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
              cards={cards}
              expanded={expanded}
              onToggle={() => setExpanded((now) => !now)}
              onOpen={open}
              onAdd={add}
              adding={adding}
              settling={busy || wallet.isFetching}
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

/** The wallet's outline while it loads: a card peeking out of the pocket. */
function WalletSkeleton() {
  const { t } = useTranslation();
  return (
    <View accessible accessibilityLabel={t("common.loading")} testID="payment-methods-loading">
      <Skeleton height={SKELETON.card} radius="lg" className="mx-3" />
      <View style={{ marginTop: -SKELETON.tuck }}>
        <Skeleton height={SKELETON.pocket} radius="lg" />
      </View>
    </View>
  );
}
