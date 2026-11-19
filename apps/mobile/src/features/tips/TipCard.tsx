import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { Button, Card, Chip, Input, Notice } from "@/components/ui";
import { proNames, type CustomerJob } from "@/features/jobs/phase";
import { formatLocale, formatMoneyExact } from "@/features/quotes/format";
import { tokens } from "@/theme";

import { useTip, type TipFailure } from "./useTip";

const DONE_ICON = 20;

const FAILURE_KEYS = {
  declined: "tips.failed",
  offline: "tips.offline",
  generic: "tips.generic",
} as const satisfies Record<TipFailure, string>;

/**
 * The tip at confirmation (#273), between the confirmation and the rating: "Add a tip for Dan?",
 * a radio group of No tip, the server's presets with their amounts, and Custom, then "Tip $12.50"
 * through Stripe's Payment Sheet. Optional and calm: nothing is preselected, a failure keeps the
 * job confirmed and offers Try again or No tip, and once decided the card is one line.
 */
export function TipCard({ requestId, job }: { requestId: string; job: CustomerJob }) {
  const { t } = useTranslation();
  const state = useTip(requestId, job);
  const { tip, selection, phase, failure, amountCents } = state;
  if (!tip) return null;
  const name = proNames(t, job).lead;
  const money = (cents: number) => formatMoneyExact(cents, formatLocale(), tip.currency);

  if (tip.status === "succeeded") {
    return (
      <View
        accessibilityLiveRegion="polite"
        className="flex-row items-center gap-3"
        testID="tip-done"
      >
        <View className="h-8 w-8 items-center justify-center rounded-pill bg-green-500">
          <ControlIcon name="check" size={DONE_ICON} color={tokens.colors["navy-900"]} />
        </View>
        <Text className="flex-1 text-callout text-navy-900">
          {t("tips.done", { name, amount: money(tip.amount_cents) })}
        </Text>
      </View>
    );
  }
  if (tip.status === "declined") {
    return (
      <Text className="text-callout text-gray-500" testID="tip-skipped">
        {t("tips.skipped")}
      </Text>
    );
  }
  if (!tip.can_tip) return null;

  const busy = phase !== "idle";
  const custom = selection?.kind === "custom";
  const { min_cents: min, max_cents: max } = tip.options;
  return (
    <Card testID="tip-card">
      <View className="gap-4">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-headline text-navy-900">
            {t("tips.title", { name })}
          </Text>
          <Text className="text-callout text-gray-500">{t("tips.body", { name })}</Text>
        </View>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t("tips.group")}
          className="flex-row flex-wrap gap-2"
          testID="tip-options"
        >
          <Chip label={t("tips.none")} onPress={state.skip} disabled={busy} testID="tip-none" />
          {tip.options.presets.map((preset) => (
            <Chip
              key={preset.percent}
              label={t("tips.percent", {
                percent: preset.percent,
                amount: money(preset.amount_cents),
              })}
              selected={selection?.kind === "percent" && selection.percent === preset.percent}
              selectionRole="radio"
              onPress={() => state.select({ kind: "percent", percent: preset.percent })}
              disabled={busy}
              testID={`tip-percent-${preset.percent}`}
            />
          ))}
          <Chip
            label={t("tips.custom")}
            selected={custom}
            selectionRole="radio"
            onPress={() => state.select({ kind: "custom" })}
            disabled={busy}
            testID="tip-custom"
          />
        </View>
        {custom ? (
          <Input
            label={t("tips.customLabel")}
            value={state.custom}
            onChangeText={state.changeCustom}
            prefix="$"
            keyboardType="decimal-pad"
            hint={t("tips.customHint", { min: money(min), max: money(max) })}
            error={
              state.customProblem === "outOfRange"
                ? t("tips.customOutOfRange", { min: money(min), max: money(max) })
                : state.customProblem === "invalid"
                  ? t("tips.customInvalid")
                  : undefined
            }
            disabled={busy}
            testID="tip-custom-amount"
          />
        ) : null}
        {failure ? (
          <Notice tone="danger" title={t(FAILURE_KEYS[failure])} testID="tip-failed" />
        ) : null}
        {phase === "delayed" ? (
          <Notice tone="info" title={t("tips.delayed")} testID="tip-delayed" />
        ) : null}
        {selection ? (
          <Button
            label={
              amountCents === null
                ? t("tips.payNoAmount")
                : t("tips.pay", { amount: money(amountCents) })
            }
            loading={phase === "working" || phase === "confirming"}
            disabled={busy}
            onPress={state.pay}
            testID="tip-pay"
          />
        ) : null}
      </View>
    </Card>
  );
}
