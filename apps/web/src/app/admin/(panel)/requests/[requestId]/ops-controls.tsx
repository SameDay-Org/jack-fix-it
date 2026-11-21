"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";

import { FOLLOWUP_NOTE_MAX_LENGTH, NOTE_MAX_LENGTH, type OpsError, type OpsState } from "../ops";

type FormAction = (previous: OpsState, form: FormData) => Promise<OpsState>;
type PressAction = () => Promise<OpsState>;

const initialState: OpsState = { error: null, saved: false };

/**
 * Where a form reports a refusal, so the action bar can keep saying it once the card's refresh
 * has taken the form away (a request another agent took meanwhile: the bar becomes who holds
 * it, and the message must survive).
 */
const Refusals = createContext<((error: OpsError) => void) | null>(null);

/**
 * Where a "Mark done" reports its outcome by follow-up id (KeptDoneRefusal): a refusal stays said
 * once the refresh has taken the row away (an admin demoted since reads only their own
 * follow-ups; a follow-up done meanwhile loses its button). `null` clears it.
 */
const DoneRefusals = createContext<((id: string, error: OpsError | null) => void) | null>(null);

const FIELD =
  "w-full rounded-md border border-gray-500/30 bg-white px-4 py-3 text-base text-navy-900 outline-none focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30";

/**
 * One request per press. A request that never answered may have gone through: the card is read
 * again and the message says so; nothing is sent again from here. `onSaved` runs once the API
 * took the action (a note's text is cleared only then).
 */
function useOps(action: FormAction, onSaved?: () => void, onRefused?: (error: OpsError) => void) {
  const router = useRouter();
  const fromBar = useContext(Refusals);
  const report = onRefused ?? fromBar;
  const sending = useRef(false);
  const [state, dispatch, pending] = useActionState(
    async (previous: OpsState, form: FormData): Promise<OpsState> => {
      let result: OpsState;
      try {
        result = await action(previous, form);
      } catch {
        router.refresh();
        result = { error: "unconfirmed", saved: false };
      }
      sending.current = false;
      if (result.saved) onSaved?.();
      if (result.error) report?.(result.error);
      return result;
    },
    initialState,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current || pending) return;
    sending.current = true;
    const form = new FormData(event.currentTarget);
    startTransition(() => dispatch(form));
  };
  return { state, pending, submit };
}

export type OpsText = {
  saving: string;
  saved: string;
  cancel: string;
  errors: Record<OpsError, string>;
};

function Outcome({ state, pending, text }: { state: OpsState; pending: boolean; text: OpsText }) {
  return (
    <>
      <p role="status" className="text-sm text-gray-500 empty:hidden">
        {pending ? text.saving : state.saved ? text.saved : ""}
      </p>
      {state.error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {text.errors[state.error]}
        </p>
      ) : null}
    </>
  );
}

/** A submit button that says it is unavailable while a request is out, and ignores a press. */
function Submit({ pending, label }: { pending: boolean; label: string }) {
  return (
    <Button
      type="submit"
      size="sm"
      aria-disabled={pending ? true : undefined}
      className={pending ? "cursor-default opacity-60" : undefined}
    >
      {label}
    </Button>
  );
}

function Counter({ id, count, max }: { id: string; count: number; max: number }) {
  return (
    <p id={id} className="text-xs text-gray-500 tabular-nums">
      {count} / {max}
    </p>
  );
}

export type ActionBarText = OpsText & {
  label: string;
  note: { open: string; label: string; submit: string };
  contacted: { press: string };
  classify: { open: string; label: string; submit: string };
  followup: {
    open: string;
    day: string;
    time: string;
    zone: string;
    note: string;
    assignee: string;
    me: string;
    noName: string;
    submit: string;
  };
};

type Panel = "note" | "classify" | "followup";

/**
 * The BDC's actions on a request (#82), under the card's header: Add note, Mark contacted,
 * Classify (only while the request can still be classified), Schedule follow-up. Each opens its
 * own small form under the bar, one at a time; Cancel or Escape closes it and gives the focus
 * back to its button. The buttons show only when the API says the caller may act
 * (`allowed`, the card's `actions_allowed`); otherwise who holds the request, and the last
 * refusal if the card changed under a form. Always the same control in the same place, so that
 * refusal survives the refresh. The API checks every action again.
 */
export function ActionBar({
  allowed,
  heldText,
  addNote,
  markContacted,
  classify,
  schedule,
  contacted,
  canClassify,
  categories,
  currentCategoryId,
  staff,
  selfId,
  days,
  text,
}: {
  allowed: boolean;
  /** Who holds the request, said when the caller may not act. */
  heldText: string;
  addNote: FormAction;
  markContacted: PressAction;
  classify: FormAction;
  schedule: FormAction;
  /** Whether the first contact is already recorded (no button then). */
  contacted: boolean;
  canClassify: boolean;
  categories: { id: string; name: string }[];
  currentCategoryId: string | null;
  /** The active staff an admin may give a follow-up to; null for an agent. */
  staff: { id: string; name: string | null }[] | null;
  selfId: string;
  /** The first and last days a follow-up may be due on, in the business time zone. */
  days: { min: string; max: string };
  text: ActionBarText;
}) {
  const [open, setOpen] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<OpsError | null>(null);
  const openers: Record<Panel, RefObject<HTMLButtonElement | null>> = {
    note: useRef<HTMLButtonElement>(null),
    classify: useRef<HTMLButtonElement>(null),
    followup: useRef<HTMLButtonElement>(null),
  };
  // The opener that takes the focus back once its form is gone.
  const returnTo = useRef<Panel | null>(null);
  const id = useId();

  useEffect(() => {
    const panel = returnTo.current;
    if (panel === null || open !== null) return;
    returnTo.current = null;
    openers[panel].current?.focus();
  });

  const toggle = (panel: Panel) => {
    if (open === panel) close();
    else setOpen(panel);
  };
  const close = () => {
    returnTo.current = open;
    setOpen(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  if (!allowed) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">{heldText}</p>
        {notice ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {text.errors[notice]}
          </p>
        ) : null}
      </div>
    );
  }

  const opener = (panel: Panel, label: string) => (
    <Button
      ref={openers[panel]}
      type="button"
      size="sm"
      variant={open === panel ? "primary" : "secondary"}
      aria-expanded={open === panel}
      aria-controls={`${id}-${panel}`}
      onClick={() => toggle(panel)}
    >
      {label}
    </Button>
  );

  return (
    <Refusals.Provider value={setNotice}>
      <div className="flex flex-col gap-4">
        <div role="group" aria-label={text.label} className="flex flex-wrap gap-2">
          {opener("note", text.note.open)}
          {contacted ? null : <ContactedButton action={markContacted} text={text} />}
          {canClassify ? opener("classify", text.classify.open) : null}
          {opener("followup", text.followup.open)}
        </div>
        {open !== null ? (
          <div
            id={`${id}-${open}`}
            onKeyDown={onKeyDown}
            className="flex flex-col gap-3 rounded-md bg-gray-50 p-4"
          >
            {open === "note" ? (
              <NoteForm action={addNote} text={text} onCancel={close} />
            ) : open === "classify" ? (
              <ClassifyForm
                action={classify}
                categories={categories}
                current={currentCategoryId}
                text={text}
                onCancel={close}
              />
            ) : (
              <FollowupForm
                action={schedule}
                staff={staff}
                selfId={selfId}
                days={days}
                text={text}
                onCancel={close}
              />
            )}
          </div>
        ) : null}
      </div>
    </Refusals.Provider>
  );
}

function Actions({
  pending,
  label,
  cancel,
  onCancel,
}: {
  pending: boolean;
  label: string;
  cancel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Submit pending={pending} label={label} />
      <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
        {cancel}
      </Button>
    </div>
  );
}

function NoteForm({
  action,
  text,
  onCancel,
}: {
  action: FormAction;
  text: ActionBarText;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  // The text is cleared only once the API kept the note: a failure keeps what was typed.
  const { state, pending, submit } = useOps(action, () => setBody(""));
  const id = useId();
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <Label htmlFor={`${id}-body`}>{text.note.label}</Label>
      <textarea
        id={`${id}-body`}
        name="body"
        rows={4}
        maxLength={NOTE_MAX_LENGTH}
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-describedby={`${id}-count`}
        className={FIELD}
      />
      <Counter id={`${id}-count`} count={body.length} max={NOTE_MAX_LENGTH} />
      <Actions
        pending={pending}
        label={text.note.submit}
        cancel={text.cancel}
        onCancel={onCancel}
      />
      <Outcome state={state} pending={pending} text={text} />
    </form>
  );
}

function ClassifyForm({
  action,
  categories,
  current,
  text,
  onCancel,
}: {
  action: FormAction;
  categories: { id: string; name: string }[];
  current: string | null;
  text: ActionBarText;
  onCancel: () => void;
}) {
  const { state, pending, submit } = useOps(action);
  const id = useId();
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <Label htmlFor={`${id}-category`}>{text.classify.label}</Label>
      <select
        id={`${id}-category`}
        name="category_id"
        defaultValue={current ?? categories[0]?.id}
        autoFocus
        className={`${FIELD} max-w-sm`}
      >
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      <Actions
        pending={pending}
        label={text.classify.submit}
        cancel={text.cancel}
        onCancel={onCancel}
      />
      <Outcome state={state} pending={pending} text={text} />
    </form>
  );
}

function FollowupForm({
  action,
  staff,
  selfId,
  days,
  text,
  onCancel,
}: {
  action: FormAction;
  staff: { id: string; name: string | null }[] | null;
  selfId: string;
  days: { min: string; max: string };
  text: ActionBarText;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const { state, pending, submit } = useOps(action, () => setNote(""));
  const id = useId();
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <p className="text-sm text-gray-500">{text.followup.zone}</p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-day`}>{text.followup.day}</Label>
          <input
            id={`${id}-day`}
            name="day"
            type="date"
            min={days.min}
            max={days.max}
            required
            autoFocus
            className={FIELD}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-time`}>{text.followup.time}</Label>
          <input id={`${id}-time`} name="time" type="time" required className={FIELD} />
        </div>
      </div>
      {staff ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-assignee`}>{text.followup.assignee}</Label>
          <select
            id={`${id}-assignee`}
            name="assigned_to"
            defaultValue={selfId}
            className={`${FIELD} max-w-sm`}
          >
            {staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id === selfId ? text.followup.me : (member.name ?? text.followup.noName)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-note`}>{text.followup.note}</Label>
        <textarea
          id={`${id}-note`}
          name="note"
          rows={2}
          maxLength={FOLLOWUP_NOTE_MAX_LENGTH}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby={`${id}-count`}
          className={FIELD}
        />
        <Counter id={`${id}-count`} count={note.length} max={FOLLOWUP_NOTE_MAX_LENGTH} />
      </div>
      <Actions
        pending={pending}
        label={text.followup.submit}
        cancel={text.cancel}
        onCancel={onCancel}
      />
      <Outcome state={state} pending={pending} text={text} />
    </form>
  );
}

/** One press records the first contact (the API keeps the first one if pressed again). */
function ContactedButton({ action, text }: { action: PressAction; text: ActionBarText }) {
  const { state, pending, submit } = useOps(() => action());
  return (
    <form onSubmit={submit} className="flex flex-col items-start gap-1">
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        aria-disabled={pending ? true : undefined}
        className={pending ? "cursor-default opacity-60" : undefined}
      >
        {text.contacted.press}
      </Button>
      <Outcome state={state} pending={pending} text={text} />
    </form>
  );
}

/**
 * Keeps a "Mark done" refusal said above the list once its row no longer offers the button
 * (`offered`: the ids of the follow-ups shown with one, from the latest render). While the row
 * still offers it, the row says the refusal itself.
 */
export function KeptDoneRefusal({
  offered,
  text,
  children,
}: {
  offered: readonly string[];
  text: OpsText;
  children?: ReactNode;
}) {
  const [notice, setNotice] = useState<{ id: string; error: OpsError } | null>(null);
  const report = (id: string, error: OpsError | null) => setNotice(error ? { id, error } : null);
  const kept = notice !== null && !offered.includes(notice.id) ? notice.error : null;
  return (
    <DoneRefusals.Provider value={report}>
      {kept ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {text.errors[kept]}
        </p>
      ) : null}
      {children}
    </DoneRefusals.Provider>
  );
}

/**
 * "Mark done" on a follow-up, for its assignee or an admin (the page offers it only to them;
 * the API checks again). One press; a repeat is harmless (the API keeps the first time).
 */
export function FollowupDone({
  id,
  action,
  label,
  text,
}: {
  id: string;
  action: PressAction;
  label: string;
  text: OpsText;
}) {
  const keep = useContext(DoneRefusals);
  const { state, pending, submit } = useOps(
    () => action(),
    () => keep?.(id, null),
    (error) => keep?.(id, error),
  );
  return (
    <form onSubmit={submit} className="flex flex-col items-start gap-1">
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        aria-disabled={pending ? true : undefined}
        className={pending ? "cursor-default opacity-60" : undefined}
      >
        {label}
      </Button>
      <Outcome state={state} pending={pending} text={text} />
    </form>
  );
}
