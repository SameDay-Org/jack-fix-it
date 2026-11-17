import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSessionGeneration } from "@/api";
import { Button, Notice, Screen, SheetContent } from "@/components/ui";

import { proJobQueryOptions, useSingleFlight } from "../api";
import { customerName } from "../format";
import { ensureLocationOn, useLocationAccess } from "../location";
import type { ProJob } from "../phase";
import { useSheetExit } from "../useSheetExit";
import { sharingConfig } from "./config";
import { isSharedStep, shareJob } from "./sender";

const MS_PER_SECOND = 1000;

/**
 * The explanation before the system's location prompt (#352, `/jobs/[id]/share-location`), shown
 * once "On my way" has put the job on the way, and opened by the job screen's line: the only way
 * to share. It says why Jack shares the position, with whom, how often, and when it stops. A
 * screen, not a sheet, so the words scroll and both choices stay in view at any text size. It
 * shows even when the permission was given before (for check-in): sharing needs the pro's
 * Continue, which asks for the "while using" permission (no prompt once given), offers Android's
 * switch-on dialog when the location is off, and shares: the choice is recorded only then, with
 * the permission granted. Refused at the system's prompt, it is a Not now: a grant made later for
 * check-in shares nothing. Refused for good, the screen says so and offers Settings in place of
 * Continue, recording nothing; back with the permission, Continue is there again. Not now asks
 * and shares nothing. A build with sharing off has nothing to explain: it leaves at once, having
 * read nothing.
 */
export function ShareLocationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const generation = useSessionGeneration();
  // Read from the job screen under it, never fetched here.
  const { data: job } = useQuery({ ...proJobQueryOptions(id, generation), enabled: false });
  const { leave, leaving, sameSession } = useSheetExit(generation);
  const flight = useSingleFlight();

  // Opened without its job on the way (a stale link, a check-in elsewhere) or with sharing off:
  // nothing to explain.
  const onTheWay = sharingConfig.enabled && job !== undefined && isSharedStep(job);
  useEffect(() => {
    if (sameSession && !onTheWay && !flight.busy && !leaving.current) leave();
  }, [flight.busy, leave, leaving, onTheWay, sameSession]);
  if (!job || !sharingConfig.enabled) return null;

  return <Explanation job={job} generation={generation} leave={leave} flight={flight} />;
}

type ExplanationProps = {
  job: ProJob;
  /** The session the screen opened in: the choice belongs to it. */
  generation: number;
  leave: () => void;
  flight: ReturnType<typeof useSingleFlight>;
};

/** The explanation itself: drawn, and the permission read, only with sharing on. */
function Explanation({ job, generation, leave, flight }: ExplanationProps) {
  const { t } = useTranslation();
  const { access, openSettings } = useLocationAccess();
  const { busy, run, mounted } = flight;
  const blocked = access === "blocked";
  const name = customerName(job) ?? t("proJobs.customerFallback");

  const share = () =>
    void run(async () => {
      try {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        if (granted) {
          // Switched off and left off (declined, or iOS, which has no such dialog): not shared.
          await ensureLocationOn().catch(() => undefined);
          await shareJob(job.id, generation);
        }
      } catch {
        // No answer from the system: nothing is shared, and the job screen says so.
      }
      // Gone already (a back while the system answered, a sign-out): one back is enough.
      if (mounted.current) leave();
    });

  return (
    // The backdrop covers the top inset and SheetContent pads the bottom one: no edges here.
    <Screen bar="light" edges={[]} testID="share-location-screen">
      <SheetContent
        title={t("proJobs.sharing.prompt.title")}
        actions={
          <View className="flex-1 gap-3">
            {blocked ? (
              <Button
                label={t("proJobs.sharing.prompt.settings")}
                size="lg"
                onPress={openSettings}
                testID="share-location-settings"
              />
            ) : (
              <Button
                label={t("proJobs.sharing.prompt.continue")}
                size="lg"
                loading={busy}
                onPress={share}
                testID="share-location-continue"
              />
            )}
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
        {blocked ? (
          <Notice
            tone="info"
            title={t("proJobs.sharing.prompt.blocked")}
            testID="share-location-blocked"
          />
        ) : null}
      </SheetContent>
    </Screen>
  );
}
