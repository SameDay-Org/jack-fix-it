import type { NavigationProp, ParamListBase } from "expo-router/react-navigation";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import {
  Button,
  Card,
  Notice,
  Screen,
  StatusBadge,
  TextSkeleton,
  type StatusTone,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { RetryNotice } from "@/features/opportunities/RetryNotice";
import { useMyProProfile } from "@/features/pro-profile";
import { useGuardedPush } from "@/features/quotes/navigation";
import { useSettledError } from "@/features/quotes/useRequestQuotes";
import { tokens } from "@/theme";

import {
  payoutsFailure,
  usePayoutsStatus,
  type Payouts,
  type PayoutsFailure,
  type PayoutsStatus,
} from "./api";
import type { PayoutsReturn } from "./links";
import { usePayoutSetup, type PayoutSetup } from "./usePayoutSetup";

const HOME = "/";
const CONTACT = "/help/contact";
/** The tick inside the "payouts are on" mark, in dp (the mark itself is `h-12 w-12`). */
const TICK_SIDE = 24;
/** What Stripe's page asks for, in the order it asks. */
const ASKS = ["bank", "identity"] as const;

/** The statuses with a setup to start or to continue. */
const SETTABLE: readonly PayoutsStatus[] = ["not_started", "incomplete"];

const STATUS_TONE: Record<PayoutsStatus, StatusTone> = {
  not_started: "neutral",
  incomplete: "warning",
  in_review: "info",
  enabled: "success",
};

const isReturn = (value: unknown): value is PayoutsReturn =>
  value === "return" || value === "refresh";

/**
 * A return link that reached the app as a route (`/pro/payouts?result=…`, see
 * `redirectSystemPath`): on Android the link lands here as well as in the browser session, and
 * after a cold start it is the only one that does. Handled once: the param is cleared as it is
 * read, the status is asked for again, and an expired link is passed on. Anyone can write such a
 * link, so its value does nothing else.
 */
function useReturnLink(
  refetch: () => Promise<unknown>,
  onReturnLink: (result: PayoutsReturn) => void,
): void {
  const { result } = useLocalSearchParams<{ result?: string | string[] }>();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  useEffect(() => {
    if (result === undefined) return;
    navigation.setParams({ result: undefined });
    if (isReturn(result)) onReturnLink(result);
    void refetch();
  }, [navigation, onReturnLink, refetch, result]);
}

/**
 * The pro's payouts (`/pro/payouts`, #277): where the payout account stands and the one thing
 * to do about it. Not set up: what Stripe will ask for, and "Set up payouts"; In progress:
 * "Continue setup"; In review: nothing to do but check again; On: the pro can be paid. The setup
 * itself is Stripe's hosted page in a browser over the app; the status is asked for again when
 * the pro is back, and whenever the app returns to the foreground on this screen.
 */
export function PayoutsScreen() {
  const { t } = useTranslation();
  const { data, error, isFetching, refetch } = usePayoutsStatus();
  const shownError = useSettledError(data, error);
  const setup = usePayoutSetup(data === undefined || SETTABLE.includes(data.status));
  useReturnLink(refetch, setup.onReturnLink);

  let content: ReactNode;
  if (data !== undefined) {
    content = (
      <>
        {/* A status that could not be asked for again: the one on screen may be behind. */}
        {shownError !== null && !setup.busy ? (
          <RetryNotice
            message={t("proPayouts.load.stale")}
            action={t("proPayouts.retry")}
            onRetry={() => void refetch()}
            busy={isFetching}
            testID="payouts-stale"
          />
        ) : null}
        <Status payouts={data} setup={setup} checking={isFetching} onCheck={() => void refetch()} />
      </>
    );
  } else if (shownError !== null) {
    content = (
      <Notice
        tone="info"
        title={t("proPayouts.load.title")}
        body={t(`proPayouts.load.${loadFailure(shownError)}`)}
        testID="payouts-load-failed"
      >
        <Button
          label={t("proPayouts.retry")}
          variant="secondary"
          loading={isFetching}
          onPress={() => void refetch()}
          testID="payouts-retry"
        />
      </Notice>
    );
  } else {
    content = (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("proPayouts.loading")}
        className="gap-3"
        testID="payouts-loading"
      >
        <TextSkeleton type="headline" width="55%" />
        <TextSkeleton type="callout" />
        <TextSkeleton type="callout" width="70%" />
      </View>
    );
  }

  return (
    <Screen bar="light" testID="payouts-screen">
      <ScrollView contentContainerClassName="gap-6 px-4 pb-6 pt-2">
        <View className="gap-2">
          <BackButton fallbackHref={HOME} />
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {t("proPayouts.title")}
            </Text>
            {data ? (
              <StatusBadge
                label={t(`proPayouts.status.${data.status}`)}
                tone={STATUS_TONE[data.status]}
                testID="payouts-status"
              />
            ) : null}
          </View>
        </View>
        {content}
      </ScrollView>
    </Screen>
  );
}

/** Which line a status that did not load shows. */
function loadFailure(error: unknown): "offline" | "unavailable" | "generic" {
  const failure = payoutsFailure(error);
  return failure === "offline" || failure === "unavailable" ? failure : "generic";
}

type StatusProps = {
  payouts: Payouts;
  setup: PayoutSetup;
  /** The status is being asked for again. */
  checking: boolean;
  onCheck: () => void;
};

/** What the status means and the one thing the pro can do about it. */
function Status({ payouts, setup, checking, onCheck }: StatusProps) {
  const { t } = useTranslation();
  const { status } = payouts;

  if (status === "enabled") return <Enabled />;
  if (status === "in_review") {
    return (
      <>
        <Message title={t("proPayouts.in_review.title")} body={t("proPayouts.in_review.body")} />
        <Button
          label={t("proPayouts.in_review.check")}
          variant="secondary"
          size="lg"
          loading={checking}
          onPress={onCheck}
          testID="payouts-check"
        />
      </>
    );
  }

  return (
    <>
      <Message title={t(`proPayouts.${status}.title`)} body={t(`proPayouts.${status}.body`)} />
      <Button
        label={t(
          status === "not_started" ? "proPayouts.action.start" : "proPayouts.action.continue",
        )}
        size="lg"
        loading={setup.busy}
        onPress={setup.start}
        testID="payouts-setup"
      />
      {/* Under the button, which never moves: what a press came to shows right below it, and on
          a short screen the action stays in sight while the details scroll. */}
      {setup.expired ? (
        <Notice
          tone="info"
          title={t("proPayouts.expired.title")}
          body={t("proPayouts.expired.body")}
          testID="payouts-expired"
        />
      ) : null}
      {setup.failure !== null ? <Failure failure={setup.failure} /> : null}
      {status === "not_started" ? <Asks /> : null}
    </>
  );
}

/** Payouts are on: a tick, and what it means for this pro. */
function Enabled() {
  const { t } = useTranslation();
  // Requests reach an approved pro only: the line never says more than the profile does.
  const verification = useMyProProfile().data?.verification_status;
  const body =
    verification === undefined
      ? t("proPayouts.enabled.body")
      : t(
          verification === "approved"
            ? "proPayouts.enabled.approved"
            : "proPayouts.enabled.notApproved",
        );

  return (
    <View className="gap-4" testID="payouts-enabled">
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="h-12 w-12 items-center justify-center rounded-pill bg-success"
      >
        <ControlIcon name="check" size={TICK_SIDE} color={tokens.colors.white} />
      </View>
      <Message title={t("proPayouts.enabled.title")} body={body} />
    </View>
  );
}

/** What Stripe's page will ask for, and who sees it: on the screen before the browser opens. */
function Asks() {
  const { t } = useTranslation();
  return (
    <Card testID="payouts-asks">
      <View className="gap-3">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("proPayouts.asks.title")}
        </Text>
        <View className="gap-2">
          {ASKS.map((ask) => (
            <View key={ask} className="flex-row gap-3">
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="mt-2 h-2 w-2 rounded-pill bg-green-500"
              />
              <Text className="flex-1 text-callout text-navy-900">
                {t(`proPayouts.asks.${ask}`)}
              </Text>
            </View>
          ))}
        </View>
        <Text className="text-callout text-gray-500">{t("proPayouts.asks.privacy")}</Text>
      </View>
    </Card>
  );
}

/** Why the setup page did not open, in calm words; a review also offers the way to support. */
function Failure({ failure }: { failure: PayoutsFailure }) {
  const { t } = useTranslation();
  const push = useGuardedPush();
  return (
    <Notice
      tone="info"
      title={t(`proPayouts.failure.${failure}.title`)}
      body={t(`proPayouts.failure.${failure}.body`)}
      testID={`payouts-failure-${failure}`}
    >
      {failure === "review" ? (
        <Button
          label={t("proPayouts.failure.review.contact")}
          variant="secondary"
          onPress={() => push(CONTACT)}
          testID="payouts-contact"
        />
      ) : null}
    </Notice>
  );
}

/** One headline and one supporting line. */
function Message({ title, body }: { title: string; body: string }) {
  return (
    <View className="gap-1" testID="payouts-message">
      <Text accessibilityRole="header" className="text-headline text-navy-900">
        {title}
      </Text>
      <Text className="text-callout text-gray-500">{body}</Text>
    </View>
  );
}
