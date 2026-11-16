import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSessionGeneration } from "@/api";
import { Button, Screen, SheetContent } from "@/components/ui";

import { proJobQueryOptions, useSingleFlight } from "../api";
import { customerName } from "../format";
import { useSheetExit } from "../useSheetExit";
import { sharingConfig } from "./config";
import { isSharedStep, shareJob } from "./sender";

const MS_PER_SECOND = 1000;

/**
 * The explanation before the system's location prompt (#352, `/jobs/[id]/share-location`), shown
 * once "On my way" has put the job on the way: why Jack shares the position, with whom, how often,
 * and when it stops. A screen, not a sheet, so the words scroll and both choices stay in view at
 * any text size. It shows even when the permission was given before (for check-in): sharing needs
 * the pro's Continue, which asks for the "while using" permission (no prompt once given) and
 * shares. Not now asks and shares nothing. Either way the job screen is next, and the job goes on:
 * not shared, it says so in one line with the way to share.
 */
export function ShareLocationScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const generation = useSessionGeneration();
  // Read from the job screen under it, never fetched here.
  const { data: job } = useQuery({ ...proJobQueryOptions(id, generation), enabled: false });
  const { leave, leaving, sameSession } = useSheetExit(generation);
  const { busy, run } = useSingleFlight();

  // Opened without its job on the way (a stale link, a check-in elsewhere): nothing to explain.
  const onTheWay = job !== undefined && isSharedStep(job);
  useEffect(() => {
    if (sameSession && !onTheWay && !busy && !leaving.current) leave();
  }, [busy, leave, leaving, onTheWay, sameSession]);
  if (!job) return null;

  const name = customerName(job) ?? t("proJobs.customerFallback");
  const share = () =>
    void run(async () => {
      try {
        await Location.requestForegroundPermissionsAsync();
        await shareJob(job.id, generation);
      } catch {
        // No answer from the system: nothing is shared, and the job screen says so.
      }
      leave();
    });

  return (
    <Screen bar="light" edges={["top"]} testID="share-location-screen">
      <SheetContent
        title={t("proJobs.sharing.prompt.title")}
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
              onPress={leave}
              testID="share-location-not-now"
            />
          </View>
        }
      >
        <Text className="text-callout text-navy-900" testID="share-location-body">
          {t("proJobs.sharing.prompt.body", {
            name,
            count: sharingConfig.intervalMs / MS_PER_SECOND,
          })}
        </Text>
        <Text className="text-callout text-gray-500" testID="share-location-stops">
          {t("proJobs.sharing.prompt.stops")}
        </Text>
      </SheetContent>
    </Screen>
  );
}
