import * as Haptics from "expo-haptics";
import { Redirect, router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { endOnboarding, register, useSession } from "@/api";
import {
  Button,
  FlowProgress,
  ID_CARD_BASE_WIDTH,
  IdCard,
  Input,
  moveAccessibilityFocus,
  Screen,
  StepSlider,
  type InputHandle,
} from "@/components/ui";
import { AddressForm } from "@/features/addresses/AddressForm";
import { offerPhoneStepAfterSignUp } from "@/features/phone/phoneFlow";

import { BackButton } from "./components/BackButton";
import { CredentialsFields } from "./components/CredentialsFields";
import { FormError } from "./components/FormError";
import { deviceLocale } from "./locale";
import type { SignUpRole } from "./roles";
import {
  HOME_CITY_MAX,
  NAME_MAX,
  SIGN_UP_STEPS,
  signUpEntry,
  type SignUpStep,
} from "./signUpSteps";
import { useCredentialsForm, type Credentials } from "./useCredentialsForm";
import { useHomeStep, useNameStep } from "./useSignUpSteps";

/** The page's side margin: the card is as wide as the content, up to its design width. */
const GUTTER = 16;

/**
 * Sign-up as one screen (#250 §1, #292): a progress bar, the ID card filling in as the person
 * types, and one step's fields under it. The entry is decided once, as the screen mounts: the
 * role chosen on the previous screen starts a new account; an account this device has not
 * finished signing up resumes at its first unfinished step.
 */
export function SignUpScreen() {
  const { role } = useLocalSearchParams<{ role?: string }>();
  const { user, onboardingUserId } = useSession();
  const [entry] = useState(() => signUpEntry(role, user, onboardingUserId));
  if (entry === null) return <Redirect href="/(auth)/role" />;
  if (entry.step === null) return <FinishedFlow />;
  return <SignUpFlow role={entry.role} firstStep={entry.step} />;
}

/**
 * The flow is over: the app opens on home, which offers the phone step as after any sign-up
 * (until #295 brings the phone into the flow).
 */
function endFlow(): void {
  offerPhoneStepAfterSignUp();
  void endOnboarding();
}

/** Every step was answered already (a relaunch right after the last save): the flow ends at once. */
function FinishedFlow() {
  useEffect(() => endFlow(), []);
  return (
    <Screen bar="light" testID="sign-up-finished">
      {null}
    </Screen>
  );
}

const failureOf = (message: string | null) =>
  message ? { message, highlight: [], offerLogin: false } : null;

function SignUpFlow({ role, firstStep }: { role: SignUpRole; firstStep: SignUpStep }) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { status, user } = useSession();
  const [step, setStep] = useState<SignUpStep>(firstStep);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [finished, setFinished] = useState(false);
  const headings = useRef<Partial<Record<SignUpStep, ComponentRef<typeof Text> | null>>>({});
  const firstFields = useRef<Partial<Record<SignUpStep, InputHandle | null>>>({});
  const lastName = useRef<InputHandle>(null);
  const index = SIGN_UP_STEPS.indexOf(step);

  const advanceFrom = useCallback((done: SignUpStep) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    const next = SIGN_UP_STEPS[SIGN_UP_STEPS.indexOf(done) + 1];
    if (next === undefined) {
      setFinished(true);
      return;
    }
    setDirection(1);
    setStep(next);
  }, []);

  // The account step signs the new account in, marked as on its flow: the gate keeps this screen.
  const createAccount = useCallback(
    async (credentials: Credentials) => {
      await register({ ...credentials, role, locale: deviceLocale() }, { onboarding: true });
      advanceFrom("account");
    },
    [advanceFrom, role],
  );
  const account = useCredentialsForm(createAccount);
  const name = useNameStep(useCallback(() => advanceFrom("name"), [advanceFrom]));
  const home = useHomeStep(
    role,
    useCallback(() => advanceFrom("home"), [advanceFrom]),
  );
  const submit = { account: account.submitForm, name: name.submit, home: home.submit }[step];
  const busy = { account: account.submitting, name: name.submitting, home: home.submitting }[step];

  // Past the account step the session belongs to the flow; a session that ends meanwhile (expired,
  // refused) sends the person back to Welcome, signed out.
  const ending = finished
    ? "finished"
    : index >= 1 && status === "signedOut"
      ? "sessionLost"
      : null;

  const stepBack = () => {
    if (busy || index < 2) return;
    setDirection(-1);
    setStep(SIGN_UP_STEPS[index - 1]);
  };

  // Nothing leaves the flow once the account exists: Back goes a step back from step 2 on, and
  // does nothing on step 1 (the account is not un-created). Nothing leaves while the account is
  // being created either: the session would arrive for a screen that is gone.
  usePreventRemove(ending === null && (index >= 1 || busy), stepBack);

  // After the commit that turned the guard off, so neither the gate's switch to the app nor the
  // way back to Welcome is blocked.
  useEffect(() => {
    if (ending === "finished") endFlow();
    if (ending === "sessionLost") router.dismissTo("/(auth)/welcome");
  }, [ending]);

  // Focus follows the step: a screen reader's to its heading, everyone else's to its first field.
  const onSettled = useCallback((settled: SignUpStep) => {
    moveAccessibilityFocus(headings.current[settled] ?? null);
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((readerOn) => {
        if (!readerOn) firstFields.current[settled]?.focus();
      })
      .catch(() => undefined);
  }, []);

  const heading = (key: SignUpStep, title: string, support: string) => (
    <View className="gap-1">
      <Text
        ref={(node) => {
          headings.current[key] = node;
        }}
        accessibilityRole="header"
        className="text-title-2 text-navy-900"
        testID={`sign-up-${key}-title`}
      >
        {title}
      </Text>
      <Text className="text-callout text-gray-500">{support}</Text>
    </View>
  );

  const nameError = (error: "required" | "tooLong" | undefined) =>
    error ? t(`address.errors.${error}`, { max: NAME_MAX }) : undefined;

  const renderStep = (key: SignUpStep) => {
    switch (key) {
      case "account":
        return (
          <View className="gap-6">
            {heading(
              key,
              t("signUp.account.title"),
              t(role === "customer" ? "signUp.asCustomer" : "signUp.asPro"),
            )}
            <CredentialsFields
              ref={(node) => {
                firstFields.current.account = node;
              }}
              form={account}
              passwordAutofill={{ textContentType: "newPassword", autoComplete: "new-password" }}
              passwordHint={t("fields.passwordHint", { min: account.passwordMinLength })}
              onLoginInstead={() => router.replace("/(auth)/login")}
              testID="sign-up-screen"
            />
          </View>
        );
      case "name":
        return (
          <View className="gap-6">
            {heading(key, t("signUp.name.title"), t("signUp.name.support"))}
            <FormError failure={failureOf(name.failure)} testID="sign-up-name-error" />
            <View className="gap-4">
              <Input
                ref={(node) => {
                  firstFields.current.name = node;
                }}
                label={t("signUp.name.first")}
                value={name.fields.first}
                onChangeText={(value) => name.set("first", value)}
                error={nameError(name.errors.first)}
                invalid={name.refused}
                disabled={name.submitting}
                maxLength={NAME_MAX}
                autoCapitalize="words"
                autoComplete="given-name"
                textContentType="givenName"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => lastName.current?.focus()}
                testID="sign-up-first-name"
              />
              <Input
                ref={lastName}
                label={t("signUp.name.last")}
                value={name.fields.last}
                onChangeText={(value) => name.set("last", value)}
                error={nameError(name.errors.last)}
                invalid={name.refused}
                disabled={name.submitting}
                maxLength={NAME_MAX}
                autoCapitalize="words"
                autoComplete="family-name"
                textContentType="familyName"
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
                onSubmitEditing={() => void name.submit()}
                testID="sign-up-last-name"
              />
            </View>
          </View>
        );
      case "home":
        return (
          <View className="gap-6">
            {heading(
              key,
              t("signUp.home.title"),
              t(role === "customer" ? "signUp.home.supportCustomer" : "signUp.home.supportPro"),
            )}
            <FormError failure={failureOf(home.failure)} testID="sign-up-home-error" />
            <AddressForm
              ref={(node) => {
                firstFields.current.home = node;
              }}
              fields={home.fields}
              errors={home.errors}
              onChange={home.set}
              disabled={home.submitting}
              placeOnly={role === "pro"}
              cityMax={HOME_CITY_MAX}
              onSubmitEditing={() => void home.submit()}
              testID="sign-up-home"
            />
          </View>
        );
    }
  };

  // The card fills in from the name step on; the account step leaves it blank.
  const cardName =
    index >= 1
      ? [name.fields.first, name.fields.last]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" ")
      : "";
  const showBack = index === 0 || index >= 2;
  const actionLabel =
    step === "account"
      ? t("signUp.submit")
      : index === SIGN_UP_STEPS.length - 1
        ? t("signUp.finish")
        : t("signUp.next");

  return (
    <Screen bar="light" testID="sign-up-flow">
      <KeyboardAvoidingView
        // Padding on both platforms, offset by the status bar `Screen` starts below (see
        // `CredentialsForm`): the keyboard never covers the field or the action.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          testID="sign-up-scroll"
        >
          {/* The row keeps its height on step 1, which has no way back: nothing below moves. */}
          <View
            style={{ opacity: showBack ? 1 : 0 }}
            pointerEvents={showBack ? "auto" : "none"}
            accessibilityElementsHidden={!showBack}
            importantForAccessibility={showBack ? "auto" : "no-hide-descendants"}
          >
            {index === 0 ? (
              <BackButton />
            ) : (
              <Button
                label={t("common.back")}
                variant="ghost"
                onPress={stepBack}
                className="-ml-5 self-start"
                testID="back-button"
              />
            )}
          </View>
          <FlowProgress
            completed={index}
            total={SIGN_UP_STEPS.length}
            label={t("signUp.progress", { step: index + 1, total: SIGN_UP_STEPS.length })}
            testID="sign-up-progress"
          />
          <View className="items-center">
            <IdCard
              variant={role}
              width={Math.min(ID_CARD_BASE_WIDTH, width - GUTTER * 2)}
              name={cardName}
              city={home.fields.city.trim()}
              state={home.fields.state.trim()}
              publicCode={user?.public_code}
              interactive
              testID="sign-up-card"
            />
          </View>
          <StepSlider
            stepKey={step}
            direction={direction}
            renderStep={renderStep}
            onSettled={onSettled}
            testID="sign-up-step"
          />
          <View className="flex-1" />
          <Button
            label={actionLabel}
            size="lg"
            loading={busy}
            onPress={() => void submit()}
            testID="sign-up-screen-submit"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
