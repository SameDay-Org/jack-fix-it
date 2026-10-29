import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Screen, TextSkeleton } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { isOpportunityDenied, useOpportunityDenied } from "@/features/pro-home/useOpportunities";

import { QuoteFormStep } from "./QuoteFormStep";
import { QuoteReviewStep } from "./QuoteReviewStep";
import { QuoteSentStep } from "./QuoteSentStep";
import { quoteBody, type QuoteCreate } from "./quoteDraft";
import { StateCard } from "./StateCard";
import {
  forgetOpportunity,
  isGone,
  useOpportunity,
  type OpportunityDetail,
} from "./useOpportunity";
import { useQuoteDraft } from "./useQuoteDraft";
import { useSendQuote, type SendFailure, type SentQuote } from "./useSendQuote";

type ClosedReason = "gone" | "alreadyQuoted";

/** How the send ended the form: the server took the quote, or the opportunity closed to it. */
type Ending = { kind: "sent"; quote: SentQuote } | { kind: "closed"; reason: ClosedReason };

/** The quote on its way, as the review showed it. */
type Outgoing = { body: QuoteCreate; takeRateBps: number };

/** A send the form may try again, or the session's own screens take over (`signedOut`). */
type RetryableFailure = Exclude<SendFailure, ClosedReason>;

type Step = { kind: "form" } | { kind: "review"; failed: boolean };

const HOME = "/";
const SKELETON_FIELDS = 3;
const IGNORE = () => undefined;

/**
 * The pro's quote for one opportunity (`/opportunities/[id]/quote`, pushed over the detail). It
 * reads the opportunity the detail already loaded (the take rate and the preferred day); once the
 * quote is sent or the opportunity closed, nothing asks for it again, since its detail now
 * answers 404. The send lives here, above the form, so its answer still lands after a denial took
 * the form away.
 */
export function QuoteFormScreen() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { send, sending } = useSendQuote(id);
  // The quote while it is out: null before the send, and again once it failed and may go again.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  // The send's answer when it ended the form; nothing here asks for the opportunity after it.
  const [ending, setEnding] = useState<Ending | null>(null);
  // Denied while this screen was up: its detail answered 404 here, or on another screen (the
  // detail under this one handles the same 404 and forgets the query, error and all). From then
  // on the opportunity is forgotten, nothing here asks for it again, and the form, its draft and
  // the kept detail go at once, so no later failure can bring them back. Adjusted while rendering,
  // so not even one more request goes out. A quote already out still gets its answer: a 201 shows
  // the confirmation (a quoted dispatch answers 404 to its detail), any failure closes.
  const [deniedId, setDeniedId] = useState<string | null>(null);
  const denied = deniedId === id;
  // A denial the app held before this screen opened leaves its own read to decide (a 404 closes,
  // a 200 lifts it) and shows no cached detail meanwhile. One recorded while it is up closes it.
  const deniedInApp = useOpportunityDenied(id);
  const [seenDeniedInApp, setSeenDeniedInApp] = useState(deniedInApp);
  if (deniedInApp !== seenDeniedInApp) setSeenDeniedInApp(deniedInApp);
  const { data, error, refetch, isFetching } = useOpportunity(id, !denied && ending === null);
  // The form keeps the opportunity it opened with: sending forgets the cached detail.
  const [kept, setKept] = useState<OpportunityDetail | undefined>(deniedInApp ? undefined : data);
  if (!denied && ending === null && (isGone(error) || (deniedInApp && !seenDeniedInApp))) {
    setDeniedId(id);
    setKept(undefined);
  } else if (!denied && !deniedInApp && data !== undefined && data !== kept) setKept(data);

  useEffect(() => {
    if (denied) void forgetOpportunity(client, id);
  }, [client, denied, id]);

  const sendQuote = (quote: Outgoing, onRetryable: (failure: RetryableFailure) => void) => {
    setOutgoing(quote);
    send(quote.body, {
      onSent: (sent) => {
        setEnding({ kind: "sent", quote: sent });
        AccessibilityInfo.announceForAccessibility(t("quoteForm.sent.title"));
      },
      onFailed: (failure) => {
        if (failure === "gone" || failure === "alreadyQuoted") {
          setEnding({ kind: "closed", reason: failure });
          return;
        }
        // Denied while it was out, drawn here or not yet: it is forgotten, nothing sends again,
        // and back goes home as from any other end.
        if (isOpportunityDenied(client, id)) {
          void forgetOpportunity(client, id);
          setEnding({ kind: "closed", reason: "gone" });
          return;
        }
        setOutgoing(null);
        onRetryable(failure);
      },
    });
  };

  if (ending !== null) return <EndedState ending={ending} />;
  if (denied) {
    return outgoing === null ? (
      <ClosedState reason="gone" onDone={() => router.dismissTo(HOME)} />
    ) : (
      <AnswerPendingState quote={outgoing} />
    );
  }
  const opportunity = deniedInApp ? undefined : (data ?? kept);
  if (opportunity !== undefined) {
    return <QuoteFlow opportunity={opportunity} sending={sending} onSend={sendQuote} />;
  }
  return (
    <Screen bar="light" testID="quote-screen">
      <ScrollView contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2">
        <BackButton fallbackHref={HOME} />
        {error ? (
          <StateCard
            title={t("quoteForm.error.title")}
            body={t("quoteForm.error.body")}
            action={t("quoteForm.error.retry")}
            onAction={() => void refetch()}
            busy={isFetching}
            testID="quote-load-error"
          />
        ) : (
          <QuoteFormSkeleton />
        )}
      </ScrollView>
    </Screen>
  );
}

type QuoteFlowProps = {
  opportunity: OpportunityDetail;
  sending: boolean;
  /** Sends the quote; `onRetryable` hears a failure that leaves the form open. */
  onSend: (quote: Outgoing, onRetryable: (failure: RetryableFailure) => void) => void;
};

/**
 * Form → review → send. Leaving is guarded: back from the review returns to the form; back from
 * a form with something typed asks before discarding.
 */
function QuoteFlow({ opportunity, sending, onSend }: QuoteFlowProps) {
  const { t } = useTranslation();
  const quote = useQuoteDraft(opportunity.preferred_date);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [discarding, setDiscarding] = useState(false);

  // expo-router blocks every removal while the guard is on, a replayed one too: a confirmed
  // discard turns it off and replays the blocked back with `repeat`.
  const guarded = !discarding && (step.kind !== "form" || quote.dirty);
  usePreventRemove(guarded, ({ repeat }) => {
    if (step.kind === "review") {
      if (!sending) setStep({ kind: "form" });
    } else {
      Alert.alert(t("quoteForm.discard.title"), t("quoteForm.discard.body"), [
        { text: t("quoteForm.discard.keep"), style: "cancel" },
        {
          text: t("quoteForm.discard.confirm"),
          style: "destructive",
          onPress: () => {
            setDiscarding(true);
            repeat();
          },
        },
      ]);
    }
  });

  const review = () => {
    if (quote.check()) setStep({ kind: "review", failed: false });
  };

  const sendQuote = () => {
    onSend({ body: quoteBody(quote.draft), takeRateBps: opportunity.take_rate_bps }, (failure) => {
      if (failure === "invalid") {
        quote.refused();
        setStep({ kind: "form" });
      } else if (failure === "failed") {
        setStep({ kind: "review", failed: true });
      }
    });
  };

  switch (step.kind) {
    case "review":
      return (
        <Screen bar="light" testID="quote-screen">
          <QuoteReviewStep
            body={quoteBody(quote.draft)}
            takeRateBps={opportunity.take_rate_bps}
            sending={sending}
            failed={step.failed}
            onSend={sendQuote}
            onEdit={() => setStep({ kind: "form" })}
          />
        </Screen>
      );
    case "form":
      return (
        <FormScreen>
          <QuoteFormStep
            quote={quote}
            takeRateBps={opportunity.take_rate_bps}
            preferredDate={opportunity.preferred_date}
            onReview={review}
          />
        </FormScreen>
      );
  }
}

/** The light page with the keyboard avoided, so the focused field and the button stay in view. */
function FormScreen({ children }: { children: ReactNode }) {
  const { top } = useSafeAreaInsets();
  return (
    <Screen bar="light" testID="quote-screen">
      <KeyboardAvoidingView
        // Padding on both platforms (the app draws edge to edge on Android); the offset adds back
        // the status bar `Screen` starts the content below.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow px-4 pb-6 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The quote went out, then the opportunity closed to this pro: the form and its draft are gone,
 * and the review, as sent and locked, waits for the answer, which leads on (sent or closed).
 * Back waits too, as it does while the review sends.
 */
function AnswerPendingState({ quote }: { quote: Outgoing }) {
  usePreventRemove(true, IGNORE);
  return (
    <Screen bar="light" testID="quote-screen">
      <QuoteReviewStep
        body={quote.body}
        takeRateBps={quote.takeRateBps}
        sending
        failed={false}
        onSend={IGNORE}
        onEdit={IGNORE}
      />
    </Screen>
  );
}

/**
 * Sent or closed by the send's answer. Back goes home, as the button does, since the detail
 * under it is no longer open.
 */
function EndedState({ ending }: { ending: Ending }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (leaving) router.dismissTo(HOME);
  }, [leaving]);
  usePreventRemove(!leaving, () => setLeaving(true));

  if (ending.kind === "closed") {
    return <ClosedState reason={ending.reason} onDone={() => setLeaving(true)} />;
  }
  return (
    <Screen bar="hero" testID="quote-screen">
      <ScrollView contentContainerClassName="flex-grow px-4 pb-6 pt-2">
        <QuoteSentStep quote={ending.quote} onDone={() => setLeaving(true)} />
      </ScrollView>
    </Screen>
  );
}

const CLOSED_COPY = {
  gone: { title: "quoteForm.closed.goneTitle", body: "quoteForm.closed.goneBody" },
  alreadyQuoted: { title: "quoteForm.closed.quotedTitle", body: "quoteForm.closed.quotedBody" },
} as const;

/** The opportunity is no longer open for this pro's quote: why, and the way back to the list. */
function ClosedState({ reason, onDone }: { reason: ClosedReason; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <Screen bar="light" testID="quote-screen">
      <ScrollView contentContainerClassName="flex-grow justify-center px-4 pb-6 pt-2">
        <StateCard
          title={t(CLOSED_COPY[reason].title)}
          body={t(CLOSED_COPY[reason].body)}
          action={t("quoteForm.closed.home")}
          onAction={onDone}
          testID={`quote-closed-${reason}`}
        />
      </ScrollView>
    </Screen>
  );
}

/** The form's first fields as placeholders while a link-opened opportunity loads. */
function QuoteFormSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("quoteForm.loading")}
      testID="quote-loading"
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="gap-6"
      >
        <View className="gap-2">
          <TextSkeleton type="title-1" width="50%" />
          <TextSkeleton type="callout" />
        </View>
        {Array.from({ length: SKELETON_FIELDS }, (_, index) => (
          <View key={index} className="gap-2">
            <TextSkeleton type="callout" width="35%" />
            <TextSkeleton type="title-1" />
          </View>
        ))}
      </View>
    </View>
  );
}
