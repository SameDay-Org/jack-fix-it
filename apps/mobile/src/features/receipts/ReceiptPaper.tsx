import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Path } from "react-native-svg";

import { StatusBadge } from "@/components/ui";
import { categoryName } from "@/features/home/useCategories";
import { tokens, withOpacity } from "@/theme";

import type { ReceiptOut } from "./api";
import { lineLabel, paymentMethodText, receiptDay, receiptMoney, STATUS_TONE } from "./format";

// The torn edge: teeth this wide and this tall, as many as fit the paper's width.
const TOOTH = 12;
const TOOTH_HEIGHT = 6;
// The dashed rules between the receipt's parts.
const DASH = "4 4";
const RULE_HEIGHT = 1;
const RULE_OPACITY = 0.4;
/** The paper's side padding (`px-5`): the rules run between them. */
const PAPER_PADDING = 20;
/** Amounts in columns: every digit the same width, so the cents line up. */
const FIGURES = { fontVariant: ["tabular-nums"] } as const;

export type ReceiptPaperProps = {
  receipt: ReceiptOut;
  /** The shared image leaves the address out (Q-R2): only the screen shows it. */
  withAddress: boolean;
  testID?: string;
};

/** A row of paper teeth: pointing up at the top of the receipt, down at its foot. */
function TornEdge({ width, foot }: { width: number; foot?: boolean }) {
  const count = Math.max(1, Math.round(width / TOOTH));
  const step = width / count;
  let d = `M0 ${TOOTH_HEIGHT}`;
  for (let i = 0; i < count; i += 1) {
    d += ` L${i * step + step / 2} 0 L${(i + 1) * step} ${TOOTH_HEIGHT}`;
  }
  d += " Z";
  return (
    <Svg
      width={width}
      height={TOOTH_HEIGHT}
      style={foot ? { transform: [{ scaleY: -1 }] } : undefined}
    >
      <Path d={d} fill={tokens.colors.white} />
    </Svg>
  );
}

/** A dashed rule across the paper. */
function Rule({ width }: { width: number }) {
  return (
    <Svg width={width} height={RULE_HEIGHT}>
      <Line
        x1={0}
        y1={0}
        x2={width}
        y2={0}
        stroke={withOpacity("gray-500", RULE_OPACITY)}
        strokeWidth={RULE_HEIGHT}
        strokeDasharray={DASH}
      />
    </Svg>
  );
}

/**
 * One line: its words on the left, the amount on the right, read together. When both don't fit
 * (a long label, a large font) the amount wraps under the words and stays right-aligned, in the
 * column of the other amounts.
 */
function Row({
  label,
  amount,
  note,
  strong = false,
  testID,
}: {
  label: string;
  amount: string;
  note?: string;
  strong?: boolean;
  testID?: string;
}) {
  const type = strong ? "text-title-2" : "text-callout";
  return (
    <View
      accessible
      accessibilityLabel={note ? `${label}, ${note}, ${amount}` : `${label}, ${amount}`}
      className="flex-row flex-wrap items-baseline justify-between gap-x-3"
      testID={testID}
    >
      <View className="shrink gap-0.5">
        <Text className={`${type} text-navy-900`}>{label}</Text>
        {note ? <Text className="text-footnote text-gray-500">{note}</Text> : null}
      </View>
      <Text className={`${type} grow text-right text-navy-900`} style={FIGURES}>
        {amount}
      </Text>
    </View>
  );
}

/**
 * The receipt as a strip of paper (#62): torn edges, dashed rules, amounts in aligned columns.
 * Every figure is the API's (frozen at payment, never computed here), and Jack's fee is never a
 * line: the customer pays the total. Read in order by assistive technology, a line at a time;
 * the paper's drawing is hidden from it.
 */
export function ReceiptPaper({ receipt, withAddress, testID }: ReceiptPaperProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const money = (cents: number) => receiptMoney(cents, receipt.currency);
  const method = paymentMethodText(receipt.payment_method);
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const inner = Math.max(0, width - 2 * PAPER_PADDING);

  return (
    <View onLayout={onLayout} testID={testID}>
      {width > 0 ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <TornEdge width={width} />
        </View>
      ) : null}
      <View className="gap-5 bg-white px-5 py-6">
        <View accessible className="items-center gap-1" testID="receipt-header">
          <View className="mb-1 h-1 w-12 rounded-pill bg-green-500" />
          <Text accessibilityRole="header" className="text-title-2 text-navy-900">
            {t("brand.name")}
          </Text>
          <Text className="text-caption text-gray-500">{receipt.issuer.legal_name}</Text>
          <Text className="mt-2 text-footnote text-navy-900" style={FIGURES}>
            {t("receipt.number", { code: receipt.receipt_number })}
          </Text>
          <Text className="text-footnote text-gray-500">
            {t("receipt.paidOn", { date: receiptDay(receipt.paid_at) })}
          </Text>
        </View>

        <Rule width={inner} />

        <View accessible className="gap-1" testID="receipt-job">
          <Text className="text-headline text-navy-900">
            {receipt.category ? categoryName(receipt.category) : t("receipt.service")}
          </Text>
          <Text className="text-callout text-navy-900">
            {t("receipt.pro", { name: receipt.pro_name })}
          </Text>
          <Text className="text-footnote text-gray-500">
            {receipt.completed_at
              ? t("receipt.done", { date: receiptDay(receipt.completed_at) })
              : t("receipt.scheduled", { date: receiptDay(receipt.scheduled_start_at) })}
          </Text>
          {withAddress && receipt.address ? (
            <Text className="text-footnote text-gray-500" testID="receipt-address">
              {`${receipt.address.line1}, ${receipt.address.city}`}
            </Text>
          ) : null}
        </View>

        <Rule width={inner} />

        <View className="gap-3" testID="receipt-lines">
          {receipt.lines.map((line, index) => (
            <Row
              key={`${line.kind}-${index}`}
              label={lineLabel(t, line, receipt)}
              amount={money(line.amount_cents)}
              note={line.at ? receiptDay(line.at) : undefined}
              testID={`receipt-line-${line.kind}`}
            />
          ))}
        </View>

        <Rule width={inner} />

        <Row
          label={t("receipt.total")}
          amount={money(receipt.total_paid_cents)}
          strong
          testID="receipt-total"
        />
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text className="shrink text-footnote text-gray-500" testID="receipt-method">
            {method ? t("receipt.paidWith", { method }) : t("receipt.paidByCard")}
          </Text>
          <StatusBadge
            label={t(`receipt.status.${receipt.status}`)}
            tone={STATUS_TONE[receipt.status]}
            testID="receipt-status"
          />
        </View>

        <Rule width={inner} />

        <View accessible className="items-center gap-1" testID="receipt-footer">
          <Text className="text-center text-callout text-navy-900">{t("receipt.thanks")}</Text>
          <Text className="text-center text-footnote text-gray-500">
            {t("receipt.questions", { email: receipt.issuer.support_email })}
          </Text>
        </View>
      </View>
      {width > 0 ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <TornEdge width={width} foot />
        </View>
      ) : null}
    </View>
  );
}
