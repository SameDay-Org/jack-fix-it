import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";

import { cx } from "@/components/ui/cx";

type RetryLineProps = {
  /** What could not be read, in one sentence. */
  message: string;
  /** The read is on its way again: the line waits for it. */
  busy: boolean;
  onRetry: () => void;
  /** Centered across its row (the confirm dock), else at the start of its block. */
  centered?: boolean;
  testID: string;
};

/**
 * A read about the report that failed, said in one calm line with "Try again" after it. The whole
 * line is the button: one target of at least 48 dp, and one name for a screen reader.
 */
export function RetryLine({ message, busy, onRetry, centered = false, testID }: RetryLineProps) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onRetry}
      className={cx("min-h-12 justify-center", centered ? "self-stretch" : "self-start")}
      testID={testID}
    >
      <Text className={cx("text-callout text-gray-500", centered && "text-center")}>
        {`${message} `}
        <Text className="font-semibold text-navy-900 underline">{t("disputes.status.retry")}</Text>
      </Text>
    </Pressable>
  );
}
