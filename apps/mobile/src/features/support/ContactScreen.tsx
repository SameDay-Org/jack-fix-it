import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Button,
  Chip,
  ChoiceCard,
  Input,
  ListGroup,
  ListRow,
  Notice,
  Screen,
  StatusBadge,
  type StatusTone,
} from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";
import { sentDay } from "@/features/history/format";
import { lengthCounter } from "@/features/request/counter";

import { MESSAGE_MAX, TICKET_TOPICS, useMyTickets, type TicketStatus } from "./api";
import { updateDraft } from "./draft";
import { useContactForm, useJobChoices } from "./useContactForm";

const STATUS_TONE: Record<TicketStatus, StatusTone> = {
  open: "info",
  in_progress: "warning",
  closed: "neutral",
};

/**
 * "Talk to Jack" (#274, part 2): a message to the Jack Fix It team from Help. A topic, the text,
 * and the job it is about when the person has one; then what they sent, with its status.
 *
 * - The draft lives in memory (`draft.ts`): leaving the form keeps it, a sign-out forgets it.
 * - What a tap on Send does, and what a failure leaves behind, is `useContactForm`.
 */
export function ContactScreen() {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const jobs = useJobChoices();
  const { draft, jobId, ticket, over, busy, sent, failure, submit, writeAnother } =
    useContactForm(jobs);

  return (
    <Screen bar="light" testID="contact-screen">
      <KeyboardAvoidingView
        // Padding on both platforms: the app draws edge to edge on Android, where the window no
        // longer resizes for the keyboard. It measures itself from the content area, which
        // `Screen` starts below the status bar: the offset adds that back.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-6 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View className="gap-2">
            <BackButton fallbackHref="/help" />
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {t("support.title")}
            </Text>
            {sent ? null : <Text className="text-body text-gray-500">{t("support.intro")}</Text>}
          </View>

          {sent ? (
            <Notice
              tone="info"
              title={t("support.sent.title")}
              body={t("support.sent.body")}
              testID="contact-sent"
            >
              <Button
                label={t("support.sent.another")}
                variant="secondary"
                onPress={writeAnother}
                testID="contact-another"
              />
            </Notice>
          ) : (
            <>
              <View className="gap-3">
                <Text className="text-headline text-navy-900">{t("support.topic.label")}</Text>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={t("support.topic.label")}
                  className="flex-row flex-wrap gap-2"
                  testID="contact-topics"
                >
                  {TICKET_TOPICS.map((topic) => (
                    <Chip
                      key={topic}
                      label={t(`support.topic.${topic}`)}
                      selected={draft.topic === topic}
                      selectionRole="radio"
                      disabled={busy}
                      onPress={() => updateDraft({ topic })}
                      testID={`contact-topic-${topic}`}
                    />
                  ))}
                </View>
              </View>

              {jobs.length > 0 ? (
                <View className="gap-3">
                  <Text className="text-headline text-navy-900">{t("support.job.label")}</Text>
                  <View
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t("support.job.label")}
                    className="gap-3"
                    testID="contact-jobs"
                  >
                    <ChoiceCard
                      title={t("support.job.none")}
                      selected={jobId === null}
                      disabled={busy}
                      onPress={() => updateDraft({ jobId: null })}
                      testID="contact-job-none"
                    />
                    {jobs.map((job) => (
                      <ChoiceCard
                        key={job.id}
                        title={job.label}
                        selected={jobId === job.id}
                        disabled={busy}
                        onPress={() => updateDraft({ jobId: job.id })}
                        testID={`contact-job-${job.id}`}
                      />
                    ))}
                  </View>
                </View>
              ) : null}

              {/* No native length limit: a long paste is never cut behind the person's back. Past
                  the limit the field says by how much, and Send waits. */}
              <Input
                label={t("support.message.label")}
                value={draft.message}
                onChangeText={(message) => updateDraft({ message })}
                hint={t("support.message.hint")}
                error={over > 0 ? t("support.message.tooLong", { count: over }) : undefined}
                multiline
                counter={lengthCounter(t, draft.message.length, MESSAGE_MAX)}
                autoCapitalize="sentences"
                disabled={busy}
                testID="contact-message"
              />

              {failure ? (
                <Notice
                  tone="info"
                  title={t(`support.failure.${failure}.title`)}
                  body={t(`support.failure.${failure}.body`)}
                  testID="contact-failure"
                />
              ) : null}

              <Button
                label={
                  failure === "offline" || failure === "failed"
                    ? t("support.retry")
                    : t("support.send")
                }
                size="lg"
                disabled={!ticket}
                loading={busy}
                onPress={submit}
                testID="contact-send"
              />
            </>
          )}

          <MyTickets />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * "Your messages": what the person sent, newest first, each with its topic, its day and where it
 * stands. Nothing while there is none. A quiet notice with a retry while the list never loaded,
 * below what is known all the same: a message that just went shows even then.
 */
function MyTickets() {
  const { t } = useTranslation();
  const tickets = useMyTickets();
  const items = tickets.data?.items ?? [];
  const failed = tickets.isError && !tickets.data?.listed;

  return (
    <>
      {items.length > 0 ? (
        <View className="gap-3">
          <Text accessibilityRole="header" className="text-title-2 text-navy-900">
            {t("support.mine.title")}
          </Text>
          <ListGroup testID="contact-mine">
            {items.map((ticket) => (
              <ListRow
                key={ticket.id}
                label={t(`support.topic.${ticket.topic}`)}
                // "Today" against the moment the list was answered, not a clock read while drawing.
                value={sentDay(t, ticket.created_at, tickets.dataUpdatedAt)}
                accessory={
                  <StatusBadge
                    label={t(`support.mine.status.${ticket.status}`)}
                    tone={STATUS_TONE[ticket.status]}
                  />
                }
                testID={`contact-ticket-${ticket.id}`}
              />
            ))}
          </ListGroup>
        </View>
      ) : null}
      {failed ? (
        <Notice tone="info" title={t("support.mine.error")} testID="contact-mine-error">
          <Button
            label={t("support.mine.retry")}
            variant="secondary"
            loading={tickets.isFetching}
            onPress={() => void tickets.refetch()}
            testID="contact-mine-retry"
          />
        </Notice>
      ) : null}
    </>
  );
}
