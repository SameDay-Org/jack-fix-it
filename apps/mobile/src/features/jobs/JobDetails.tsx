import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";

import { ControlIcon } from "@/components/icons";
import { Avatar, useFlag, VerifiedBadge } from "@/components/ui";
import { formatMoneyExact, formatRating, joinFacts } from "@/features/quotes/format";
import { displayName } from "@/features/quotes/quoteText";
import { pressedTransform, tokens, withOpacity } from "@/theme";

import type { CustomerJob } from "./phase";

const CHEVRON = 20;
const RIPPLE_OPACITY = 0.1;
const RIPPLE = { color: withOpacity("navy-900", RIPPLE_OPACITY) };

export type ProRowProps = {
  pro: CustomerJob["pro"];
  /** Opens the pro's profile; absent while the accepted quote it hangs off is not known. */
  onPress?: () => void;
};

/**
 * Who is doing the job: initials (the API sends no photo), the name with the verified seal, and
 * the figures the quote showed. The whole row opens the pro's public profile.
 */
export function ProRow({ pro, onPress }: ProRowProps) {
  const { t } = useTranslation();
  const [pressed, pressIn, pressOut] = useFlag();
  const name = displayName(t, pro.name);
  const rating = formatRating(pro.rating_avg);
  const jobs = t("jobs.pro.jobs", { count: pro.jobs_count });
  const facts = joinFacts([...(rating ? [t("jobs.pro.rating", { rating })] : []), jobs]);
  // Spoken in words: "Dan K., verified, rated 4.8, 12 jobs".
  const summary = [
    name,
    pro.verified ? t("jobs.pro.verified") : null,
    rating ? t("jobs.pro.rated", { rating }) : null,
    jobs,
  ]
    .filter(Boolean)
    .join(", ");

  const content = (
    <>
      <Avatar name={name} size="md" />
      <View className="flex-1 gap-0.5">
        <Text className="text-headline text-navy-900">
          {name}
          {pro.verified ? <VerifiedBadge type="headline" testID="job-pro-verified" /> : null}
        </Text>
        <Text className="text-footnote text-gray-500">{facts}</Text>
      </View>
      {onPress ? (
        <ControlIcon name="chevron" size={CHEVRON} color={tokens.colors["gray-500"]} />
      ) : null}
    </>
  );

  return (
    <View className="gap-3">
      <Text className="text-headline text-navy-900">{t("jobs.pro.title")}</Text>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={summary}
          accessibilityHint={t("jobs.pro.hint")}
          onPress={onPress}
          onPressIn={pressIn}
          onPressOut={pressOut}
          android_ripple={RIPPLE}
          // A style, not a `scale-*` class: a transform class that appears on press remounts the view.
          style={pressed ? pressedTransform : undefined}
          className="min-h-12 flex-row items-center gap-3 rounded-lg"
          testID="job-pro"
        >
          {content}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={summary}
          className="min-h-12 flex-row items-center gap-3"
          testID="job-pro"
        >
          {content}
        </View>
      )}
    </View>
  );
}

/** What the customer paid: the total, and the tax inside it when there is any. */
export function PaidRow({ job }: { job: CustomerJob }) {
  const { t } = useTranslation();
  const total = formatMoneyExact(job.customer_total_cents);

  return (
    <View
      accessible
      accessibilityLabel={
        job.tax_cents > 0
          ? t("jobs.paid.labelWithTax", { total, tax: formatMoneyExact(job.tax_cents) })
          : t("jobs.paid.label", { total })
      }
      className="flex-row items-baseline justify-between gap-3 border-t border-gray-500/15 pt-4"
      testID="job-paid"
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-headline text-navy-900">{t("jobs.paid.title")}</Text>
        {job.tax_cents > 0 ? (
          <Text className="text-footnote text-gray-500">
            {t("jobs.paid.tax", { tax: formatMoneyExact(job.tax_cents) })}
          </Text>
        ) : null}
      </View>
      <Text className="text-title-2 text-navy-900">{total}</Text>
    </View>
  );
}
