import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { useSessionGeneration } from "@/api";
import { Button, CodeInput, Notice, SheetContent } from "@/components/ui";

import { proJobQueryOptions } from "./api";
import { ARRIVAL_CODE_LENGTH } from "./config";
import { customerName } from "./format";
import { jobStep } from "./phase";
import { useCheckIn } from "./useCheckIn";
import { useSheetExit } from "./useSheetExit";

/**
 * "I've arrived" (`/jobs/[id]/check-in`, a fit-to-contents sheet over the job): the customer's
 * 4-digit arrival code in large cells on the number pad, then "Check in", which sends it with
 * the phone's position. The location is asked for here only, after a line on why; refused for
 * good, the sheet says why it is needed and opens Settings (no check-in without it); a slow fix
 * gets a calm retry. A wrong code says how many tries are left; a locked check-in says so and
 * that the team knows, with nothing to retry.
 */
export function CheckInSheet() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const generation = useSessionGeneration();
  // Read from the screen under the sheet, never fetched here.
  const { data: job } = useQuery({ ...proJobQueryOptions(id, generation), enabled: false });
  const name = (job && customerName(job)) ?? t("proJobs.customerFallback");
  const { leave, leaving, sameSession } = useSheetExit(generation);
  const checkIn = useCheckIn(id, name, leave);
  const { phase } = checkIn;

  // Opened without its job on screen (a stale link), or not on the way any more (checked in
  // elsewhere, cancelled): nothing to do. A locked check-in keeps the sheet to say so.
  const open = job !== undefined && (jobStep(job) === "onTheWay" || phase === "locked");
  const working = phase === "locating" || phase === "sending";
  useEffect(() => {
    if (sameSession && !open && !working && !leaving.current) leave();
  }, [leave, leaving, open, sameSession, working]);
  if (!job) return null;

  const close = leave;

  return (
    <SheetContent
      title={phase === "ask" ? t("proJobs.checkIn.ask.title") : t("proJobs.checkIn.title")}
      fitToContents
      testID="check-in-sheet"
      actions={<View className="flex-1 gap-3">{actionsFor(phase)}</View>}
    >
      {phase === "ask" ? (
        <Text className="text-callout text-navy-900" testID="check-in-ask">
          {t("proJobs.checkIn.ask.body", { name })}
        </Text>
      ) : phase === "blocked" ? (
        <Notice
          tone="danger"
          title={t("proJobs.checkIn.blocked.title")}
          body={t("proJobs.checkIn.blocked.body", { name })}
          testID="check-in-blocked"
        />
      ) : phase === "off" ? (
        <Notice
          tone="danger"
          title={t("proJobs.checkIn.off.title")}
          body={t("proJobs.checkIn.off.body")}
          testID="check-in-off"
        />
      ) : phase === "timeout" ? (
        <Notice
          tone="info"
          title={t("proJobs.checkIn.timeout.title")}
          body={t("proJobs.checkIn.timeout.body")}
          testID="check-in-timeout"
        />
      ) : phase === "locked" ? (
        <Notice
          tone="danger"
          title={t("proJobs.screen.locked.title")}
          body={t("proJobs.screen.locked.body")}
          testID="check-in-locked"
        />
      ) : (
        <>
          <Text className="text-callout text-gray-500" testID="check-in-body">
            {t("proJobs.checkIn.body", { name })}
          </Text>
          <CodeInput
            label={t("proJobs.checkIn.code")}
            value={checkIn.code}
            onChangeText={checkIn.changeCode}
            length={ARRIVAL_CODE_LENGTH}
            error={checkIn.message ?? undefined}
            disabled={working}
            autoFocus
            testID="check-in-code"
          />
          <Text
            accessibilityLiveRegion="polite"
            className="text-footnote text-gray-500"
            testID="check-in-note"
          >
            {phase === "locating"
              ? t("proJobs.checkIn.locating")
              : t("proJobs.checkIn.locationNote")}
          </Text>
        </>
      )}
    </SheetContent>
  );

  function actionsFor(current: typeof phase) {
    const notNow = (
      <Button
        label={t("proJobs.checkIn.notNow")}
        variant="ghost"
        size="lg"
        disabled={working}
        onPress={current === "entry" || working ? close : checkIn.back}
        testID="check-in-cancel"
      />
    );
    switch (current) {
      case "ask":
        return (
          <>
            <Button
              label={t("proJobs.checkIn.ask.continue")}
              size="lg"
              onPress={checkIn.allow}
              testID="check-in-allow"
            />
            {notNow}
          </>
        );
      case "blocked":
        return (
          <>
            <Button
              label={t("proJobs.checkIn.blocked.settings")}
              size="lg"
              onPress={checkIn.openSettings}
              testID="check-in-settings"
            />
            {notNow}
          </>
        );
      case "off":
      case "timeout":
        return (
          <>
            <Button
              label={
                current === "off"
                  ? t("proJobs.checkIn.off.retry")
                  : t("proJobs.checkIn.timeout.retry")
              }
              size="lg"
              onPress={checkIn.retry}
              testID="check-in-retry"
            />
            {notNow}
          </>
        );
      case "locked":
        return (
          <Button
            label={t("proJobs.checkIn.close")}
            size="lg"
            onPress={close}
            testID="check-in-close"
          />
        );
      default:
        return (
          <>
            <Button
              label={t("proJobs.checkIn.submit")}
              size="lg"
              disabled={!checkIn.complete}
              loading={working}
              onPress={checkIn.submit}
              testID="check-in-submit"
            />
            {notNow}
          </>
        );
    }
  }
}
