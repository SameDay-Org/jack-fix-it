import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Screen, TextSkeleton } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { QuoteFormStep } from "./QuoteFormStep";
import { QuoteReviewStep } from "./QuoteReviewStep";
import { QuoteSentStep } from "./QuoteSentStep";
import { quoteBody } from "./quoteDraft";
import { StateCard } from "./StateCard";
import {
  forgetOpportunity,
  isGone,
  useOpportunity,
  type OpportunityDetail,
} from "./useOpportunity";
import { useQuoteDraft } from "./useQuoteDraft";
import { useSendQuote, type SentQuote } from "./useSendQuote";

type ClosedReason = "gone" | "alreadyQuoted";

type Step =
  | { kind: "form" }
  | { kind: "review"; failed: boolean }
  | { kind: "sent"; quote: SentQuote }
  | { kind: "closed"; reason: ClosedReason };

const HOME = "/";
const SKELETON_FIELDS = 3;

/**
 * The pro's quote for one opportunity (`/opportunities/[id]/quote`, pushed over the detail). It
 * reads the opportunity the detail already loaded (the take rate and the preferred day); once the
 * quote is sent or the opportunity closed, nothing asks for it again, since its detail now
 * answers 404.
 */
export function QuoteFormScreen() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [settled, setSettled] = useState(false);
  const { data, error, refetch, isFetching } = useOpportunity(id, !settled);
  // The form keeps the opportunity it opened with: sending forgets the cached detail.
  const [kept, setKept] = useState<OpportunityDetail | undefined>(data);
  if (data !== undefined && data !== kept) setKept(data);
  const opportunity = data ?? kept;
  const goneOnOpen = opportunity === undefined && isGone(error);

  useEffect(() => {
    if (goneOnOpen) void forgetOpportunity(client, id);
  }, [client, goneOnOpen, id]);

  if (opportunity !== undefined) {
    return <QuoteFlow opportunity={opportunity} onSettled={() => setSettled(true)} />;
  }
  if (goneOnOpen) {
    return <ClosedState reason="gone" onDone={() => router.dismissTo(HOME)} />;
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
  /** The quote went out or the opportunity closed: its detail is not asked for again. */
  onSettled: () => void;
};

/**
 * Form → review → sent, or closed. Leaving is guarded: back from the review returns to the form;
 * back from a form with something typed asks before discarding; back from the end goes home, as
 * its button does, since the detail under it is no longer open.
 */
function QuoteFlow({ opportunity, onSettled }: QuoteFlowProps) {
  const { t } = useTranslation();
  const quote = useQuoteDraft(opportunity.preferred_date);
  const { send, sending } = useSendQuote(opportunity.dispatch_id);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [leaving, setLeaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const ended = step.kind === "sent" || step.kind === "closed";

  useEffect(() => {
    if (leaving) router.dismissTo(HOME);
  }, [leaving]);

  // expo-router blocks every removal while the guard is on, a replayed one too: a confirmed
  // discard turns it off and replays the blocked back with `repeat`.
  const guarded = !leaving && !discarding && (step.kind !== "form" || quote.dirty);
  usePreventRemove(guarded, ({ repeat }) => {
    if (ended) setLeaving(true);
    else if (step.kind === "review") {
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

  const sendQuote = () =>
    send(quoteBody(quote.draft), {
      onSent: (sent) => {
        onSettled();
        setStep({ kind: "sent", quote: sent });
        AccessibilityInfo.announceForAccessibility(t("quoteForm.sent.title"));
      },
      onFailed: (failure) => {
        if (failure === "gone" || failure === "alreadyQuoted") {
          onSettled();
          setStep({ kind: "closed", reason: failure });
        } else if (failure === "invalid") {
          quote.refused();
          setStep({ kind: "form" });
        } else if (failure === "failed") {
          setStep({ kind: "review", failed: true });
        }
      },
    });

  switch (step.kind) {
    case "sent":
      return (
        <Screen bar="hero" testID="quote-screen">
          <ScrollView contentContainerClassName="flex-grow px-4 pb-6 pt-2">
            <QuoteSentStep quote={step.quote} onDone={() => setLeaving(true)} />
          </ScrollView>
        </Screen>
      );
    case "closed":
      return <ClosedState reason={step.reason} onDone={() => setLeaving(true)} />;
    case "review":
      return (
        <Screen bar="light" testID="quote-screen">
          <ScrollView contentContainerClassName="flex-grow px-4 pb-6 pt-2">
            <QuoteReviewStep
              body={quoteBody(quote.draft)}
              takeRateBps={opportunity.take_rate_bps}
              sending={sending}
              failed={step.failed}
              onSend={sendQuote}
              onEdit={() => setStep({ kind: "form" })}
            />
          </ScrollView>
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
