import type { TFunction } from "i18next";

import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

import { LocalTime } from "../../local-time";
import { completeFollowup } from "../actions";
import { type DueTone, dueTone, type Followup, type Note, OPS_ERRORS } from "../ops";
import { type ActionBarText, FollowupDone, KeptDoneRefusal, type OpsText } from "./ops-controls";

// Overdue is red, due today amber (navy text on the warning fill), as the queue's timers; a
// word goes with the color.
const TONE: Record<Exclude<DueTone, "later">, string> = {
  overdue: "bg-danger text-white",
  today: "bg-warning text-navy-900",
};

/** The zone's name as people say it ("Eastern Time"), in the reader's language. */
export function zoneName(zone: string, locale: string): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "longGeneric" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** The action messages, with the follow-up window written in. */
export function opsText(t: TFunction, days: number): OpsText {
  return {
    saving: t("admin.requests.ops.saving"),
    saved: t("admin.requests.ops.saved"),
    cancel: t("admin.requests.ops.cancel"),
    errors: Object.fromEntries(
      OPS_ERRORS.map((code) => [code, t(`admin.requests.ops.errors.${code}`, { days })]),
    ) as OpsText["errors"],
  };
}

/** The action bar's copy (ops-controls.tsx), in the reader's language. */
export function actionBarText(
  t: TFunction,
  days: number,
  zone: string,
  locale: Locale,
): ActionBarText {
  return {
    ...opsText(t, days),
    label: t("admin.requests.ops.label"),
    note: {
      open: t("admin.requests.ops.note.open"),
      label: t("admin.requests.ops.note.label"),
      submit: t("admin.requests.ops.note.submit"),
    },
    contacted: { press: t("admin.requests.ops.contacted.press") },
    classify: {
      open: t("admin.requests.ops.classify.open"),
      label: t("admin.requests.ops.classify.label"),
      submit: t("admin.requests.ops.classify.submit"),
    },
    followup: {
      open: t("admin.requests.ops.followup.open"),
      day: t("admin.requests.ops.followup.day"),
      time: t("admin.requests.ops.followup.time"),
      zone: t("admin.requests.ops.followup.zone", { zone: zoneName(zone, locale) }),
      note: t("admin.requests.ops.followup.note"),
      assignee: t("admin.requests.ops.followup.assignee"),
      me: t("admin.requests.ops.followup.me"),
      noName: t("admin.requests.ops.followup.noName"),
      submit: t("admin.requests.ops.followup.submit"),
    },
  };
}

/**
 * The request's internal notes, newest first: who wrote each ("You" for the reader) and when,
 * and its text as written. React writes it as text, never as HTML; CSS keeps its line breaks.
 * Staff only: the API never puts a note in a customer's or a pro's answer.
 */
export function NotesThread({
  notes,
  selfId,
  t,
  locale,
}: {
  notes: Note[];
  selfId: string;
  t: TFunction;
  locale: Locale;
}) {
  // The API sends them oldest first.
  const newestFirst = [...notes].reverse();
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle id="notes-title">{t("admin.requests.ops.notes.title")}</CardTitle>
      <p className="text-sm text-gray-500">{t("admin.requests.ops.notes.hint")}</p>
      {notes.length === 0 ? (
        <CardDescription>{t("admin.requests.ops.notes.none")}</CardDescription>
      ) : (
        <ol aria-labelledby="notes-title" className="flex flex-col gap-3">
          {newestFirst.map((note) => (
            <li key={note.id} className="flex flex-col gap-2 rounded-md bg-gray-50 p-4">
              <p className="text-sm text-gray-500">
                <span className="font-semibold text-navy-900">
                  {note.author.id === selfId
                    ? t("admin.requests.ops.notes.you")
                    : (note.author.name ?? t("admin.requests.ops.notes.noName"))}
                </span>
                {" · "}
                <LocalTime iso={note.created_at} locale={locale} />
              </p>
              <p data-note className="break-words whitespace-pre-wrap">
                {note.body}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * The request's follow-ups the API shows this reader, by due time: an agent only the ones
 * assigned to them, an admin every one (the API decides by the account's current role; the
 * copy says which, so an agent never reads the list as everyone's). What to do, when (overdue in
 * red, today amber), for whom, and "Mark done" for its assignee or an admin. Done ones are
 * greyed with the time they were done.
 */
export function FollowupsSection({
  followups,
  requestId,
  self,
  t,
  locale,
  zone,
  nowMs,
  text,
}: {
  followups: Followup[];
  requestId: string;
  self: { id: string; role: string };
  t: TFunction;
  locale: Locale;
  zone: string;
  nowMs: number;
  text: OpsText;
}) {
  const scope = self.role === "admin" ? "all" : "mine";
  const offersDone = (followup: Followup) =>
    followup.done_at === null && (followup.assigned_to.id === self.id || self.role === "admin");
  return (
    <Card className="flex flex-col gap-4">
      <CardTitle id="followups-title">{t("admin.requests.ops.followups.title")}</CardTitle>
      <CardDescription>{t(`admin.requests.ops.followups.scope.${scope}`)}</CardDescription>
      <KeptDoneRefusal offered={followups.filter(offersDone).map(({ id }) => id)} text={text}>
        {followups.length === 0 ? (
          <CardDescription>{t(`admin.requests.ops.followups.none.${scope}`)}</CardDescription>
        ) : (
          <ul aria-labelledby="followups-title" className="flex flex-col gap-3">
            {followups.map((followup) => {
              const done = followup.done_at !== null;
              const tone = done ? "later" : dueTone(followup.due_at, nowMs, zone);
              const mine = followup.assigned_to.id === self.id;
              return (
                <li
                  key={followup.id}
                  data-followup={done ? "done" : tone}
                  className={cn(
                    "flex flex-col gap-2 rounded-md p-4",
                    done ? "bg-gray-50 text-gray-500" : "bg-white ring-1 ring-gray-500/20",
                  )}
                >
                  <p className="break-words whitespace-pre-wrap">{followup.note}</p>
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-gray-500">{t("admin.requests.ops.followups.due")}</span>
                    <LocalTime iso={followup.due_at} locale={locale} />
                    {tone === "later" ? null : (
                      <span
                        className={cn(
                          "inline-flex items-center rounded-pill px-3 py-0.5 text-xs font-semibold",
                          TONE[tone],
                        )}
                      >
                        {t(`admin.requests.ops.followups.${tone}`)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm">
                    <span className="text-gray-500">
                      {t("admin.requests.ops.followups.assignee")}{" "}
                    </span>
                    {mine
                      ? t("admin.requests.ops.followups.you")
                      : (followup.assigned_to.name ?? t("admin.requests.ops.followups.noName"))}
                  </p>
                  {done ? (
                    <p className="text-sm">
                      {t("admin.requests.ops.followups.doneAt")}{" "}
                      <LocalTime iso={followup.done_at as string} locale={locale} />
                    </p>
                  ) : offersDone(followup) ? (
                    <FollowupDone
                      id={followup.id}
                      action={completeFollowup.bind(null, requestId, followup.id)}
                      label={t("admin.requests.ops.followups.done")}
                      text={text}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </KeptDoneRefusal>
    </Card>
  );
}
