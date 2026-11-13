import { useTranslation } from "react-i18next";
import { Text } from "react-native";

import { formatDay } from "@/features/opportunities/format";
import { withPeriod } from "@/features/request/period";

import { useMyRequest } from "./useMyRequest";

/**
 * "Preferred: Tue, Nov 4 · Morning": the day (and time of day) the customer asked for, as the pros
 * see it. Nothing for a flexible request, or until the request has loaded.
 */
export function RequestPreferred({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const request = useMyRequest(requestId).data;
  if (!request?.preferred_date) return null;

  return (
    <Text className="text-footnote text-gray-500" testID="request-preferred">
      {t("quotes.preferred", {
        date: withPeriod(t, formatDay(request.preferred_date), request.preferred_period),
      })}
    </Text>
  );
}
