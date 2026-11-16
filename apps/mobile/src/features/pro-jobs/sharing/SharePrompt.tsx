import * as Location from "expo-location";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, SheetContent } from "@/components/ui";

import { useSingleFlight } from "../api";
import { sharingConfig } from "./config";
import { startSharing } from "./sender";

const MS_PER_SECOND = 1000;

type SharePromptProps = {
  jobId: string;
  /** The customer's first name, or the fallback that reads mid-sentence. */
  name: string;
  /** The session "On my way" was sent in. */
  generation: number;
  /** Closes the sheet, whatever the pro chose. */
  onDone: () => void;
};

/**
 * The explanation before the system's location prompt (#352), in the "On my way" sheet once the
 * job is on the way: why Jack shares the position, with whom, only on the way, and when it stops.
 * Continue asks for the "while using" permission and, granted, starts sharing; Not now asks
 * nothing. Either way the sheet closes, and the job still goes on: without the permission, the
 * job screen says so in one line with the way to turn it on.
 */
export function SharePrompt({ jobId, name, generation, onDone }: SharePromptProps) {
  const { t } = useTranslation();
  const { busy, run } = useSingleFlight();
  const seconds = sharingConfig.intervalMs / MS_PER_SECOND;

  const share = () =>
    void run(async () => {
      try {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        if (granted) await startSharing(jobId, generation);
      } catch {
        // No answer from the system: nothing is shared, and the job screen says so.
      }
      onDone();
    });

  return (
    <SheetContent
      title={t("proJobs.sharing.prompt.title")}
      fitToContents
      testID="share-location-sheet"
      actions={
        <View className="flex-1 gap-3">
          <Button
            label={t("proJobs.sharing.prompt.continue")}
            size="lg"
            loading={busy}
            onPress={share}
            testID="share-location-continue"
          />
          <Button
            label={t("proJobs.sharing.prompt.notNow")}
            variant="ghost"
            size="lg"
            disabled={busy}
            onPress={onDone}
            testID="share-location-not-now"
          />
        </View>
      }
    >
      <Text className="text-callout text-navy-900" testID="share-location-body">
        {t("proJobs.sharing.prompt.body", { name, count: seconds })}
      </Text>
      <Text className="text-callout text-gray-500" testID="share-location-stops">
        {t("proJobs.sharing.prompt.stops")}
      </Text>
    </SheetContent>
  );
}
