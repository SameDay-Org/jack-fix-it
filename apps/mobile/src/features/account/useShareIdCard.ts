import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { IdCardShareHandle } from "@/components/ui";
import { useShareImage } from "@/features/share/useShareImage";

/** Shares the ID card as a PNG (#293), with the account's words: see `useShareImage`. */
export function useShareIdCard(render: RefObject<IdCardShareHandle | null>) {
  const { t } = useTranslation();
  return useShareImage(render, {
    dialogTitle: t("account.share.dialogTitle"),
    failed: t("account.share.failed"),
  });
}
