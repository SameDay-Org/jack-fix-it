import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { sessionGeneration, useSessionGeneration } from "@/api";
import { Button, Chip, SheetContent, ValueStepper } from "@/components/ui";
import { announce } from "@/components/ui/focus";
import { formatTimeOfDay } from "@/features/opportunities/format";
import { formatMinutes } from "@/features/quotes/format";

import { markOnTheWay, proJobQueryOptions, stepFailure, useSingleFlight } from "./api";
import { ETA_MAX_MINUTES, ETA_MIN_MINUTES, nextEta, previousEta, proJobsConfig } from "./config";
import { customerName } from "./format";
import { jobStep } from "./phase";
import { reportStepFailure } from "./ProJobScreen";
import { useSheetExit } from "./useSheetExit";

const MINUTE_MS = 60_000;

/** The pro's pick: one of the presets, or the custom time (`custom` holds its minutes). */
type Choice = { kind: "preset"; minutes: number } | { kind: "custom" } | null;

/**
 * "On my way" (`/jobs/[id]/on-the-way`, a fit-to-contents sheet over the job): when the pro
 * expects to arrive, from one-tap presets or a custom time from 5 minutes to 4 hours, then one
 * POST. On the way already, it updates only the arrival time ("Update arrival time"). The job
 * screen under it redraws with the answer as it closes. Offline, the sheet stays with the reason;
 * a job that moved on or went away closes it with a toast.
 */
export function OnTheWaySheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const generation = useSessionGeneration();
  const client = useQueryClient();
  // Read from the screen under the sheet, never fetched here.
  const { data: job } = useQuery({ ...proJobQueryOptions(id, generation), enabled: false });
  const presets = proJobsConfig.etaPresetsMinutes;
  const [choice, setChoice] = useState<Choice>(null);
  const [custom, setCustom] = useState(presets[presets.length - 1]);
  const [offline, setOffline] = useState(false);
  const { busy, run, mounted } = useSingleFlight();
  const { leave, leaving, sameSession } = useSheetExit(generation);
  // As the sheet opened: its words stay put while the answer redraws the job under it.
  const [updating] = useState(() => job !== undefined && jobStep(job) === "onTheWay");
  const [openedAt] = useState(Date.now);

  // Opened without its job on screen (a stale link), or the job moved past the arrival time
  // while the sheet was up: there is nothing to send.
  const step = job ? jobStep(job) : null;
  const usable = step === "scheduled" || step === "onTheWay";
  useEffect(() => {
    if (sameSession && !usable && !busy && !leaving.current) leave();
  }, [busy, leave, leaving, sameSession, usable]);
  if (!job) return null;

  const name = customerName(job) ?? t("proJobs.customerFallback");
  const minutes = choice === null ? null : choice.kind === "preset" ? choice.minutes : custom;
  const arrival = minutes === null ? null : formatTimeOfDay(openedAt + minutes * MINUTE_MS);

  const send = () => {
    if (minutes === null) return;
    void run(async () => {
      setOffline(false);
      const started = sessionGeneration();
      try {
        await markOnTheWay(client, job.id, minutes, started);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        if (updating) announce(t("proJobs.announce.etaUpdated"));
        if (mounted.current) leave();
      } catch (error) {
        const failure = stepFailure(error);
        if (failure === "signedOut") return;
        if (failure === "offline" && mounted.current) {
          setOffline(true);
          announce(t("proJobs.failure.offline"));
          return;
        }
        reportStepFailure(t, client, job.id, started, failure);
        if (mounted.current) leave();
      }
    });
  };

  return (
    <SheetContent
      title={updating ? t("proJobs.eta.titleUpdate") : t("proJobs.eta.title")}
      fitToContents
      testID="on-the-way-sheet"
      actions={
        <View className="flex-1 gap-3">
          <Button
            label={updating ? t("proJobs.eta.sendUpdate") : t("proJobs.eta.send")}
            size="lg"
            disabled={minutes === null}
            loading={busy}
            onPress={send}
            testID="on-the-way-send"
          />
          <Button
            label={t("proJobs.eta.notNow")}
            variant="ghost"
            size="lg"
            disabled={busy}
            onPress={leave}
            testID="on-the-way-cancel"
          />
        </View>
      }
    >
      <Text className="text-callout text-gray-500" testID="on-the-way-body">
        {updating && job.eta_at
          ? t("proJobs.eta.current", { time: formatTimeOfDay(Date.parse(job.eta_at)) })
          : t("proJobs.eta.body", { name })}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("proJobs.eta.choices")}
        className="flex-row flex-wrap gap-2"
        testID="on-the-way-choices"
      >
        {presets.map((preset) => (
          <Chip
            key={preset}
            label={formatMinutes(t, preset)}
            selected={choice?.kind === "preset" && choice.minutes === preset}
            selectionRole="radio"
            disabled={busy}
            onPress={() => setChoice({ kind: "preset", minutes: preset })}
            testID={`on-the-way-preset-${preset}`}
          />
        ))}
        <Chip
          label={t("proJobs.eta.other")}
          selected={choice?.kind === "custom"}
          selectionRole="radio"
          disabled={busy}
          onPress={() => {
            // The custom time starts where the pro's last pick was, so "a bit more" is one tap.
            if (choice?.kind === "preset") setCustom(choice.minutes);
            setChoice({ kind: "custom" });
          }}
          testID="on-the-way-other"
        />
      </View>
      {choice?.kind === "custom" ? (
        <ValueStepper
          label={t("proJobs.eta.custom")}
          valueText={formatMinutes(t, custom)}
          onDecrement={() => setCustom(previousEta)}
          onIncrement={() => setCustom(nextEta)}
          canDecrement={!busy && custom > ETA_MIN_MINUTES}
          canIncrement={!busy && custom < ETA_MAX_MINUTES}
          decrementLabel={t("proJobs.eta.earlier")}
          incrementLabel={t("proJobs.eta.later")}
          testID="on-the-way-custom"
        />
      ) : null}
      {arrival ? (
        <Text className="text-callout text-navy-900" testID="on-the-way-arrival">
          {t("proJobs.eta.around", { time: arrival })}
        </Text>
      ) : null}
      {offline ? (
        <Text className="text-callout text-danger" testID="on-the-way-offline">
          {t("proJobs.failure.offline")}
        </Text>
      ) : null}
    </SheetContent>
  );
}
