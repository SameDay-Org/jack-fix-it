import * as Haptics from "expo-haptics";
import { Redirect, router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { endOnboarding, isCurrentGeneration, register, sessionGeneration, useSession } from "@/api";
import {
  Button,
  CodeInput,
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
import { CODE_LENGTH, phoneConfig } from "@/features/phone/config";
import { formatE164 } from "@/features/phone/phoneNumber";

import { BackButton } from "./components/BackButton";
import { CredentialsFields } from "./components/CredentialsFields";
import { FormError } from "./components/FormError";
import { SelfieFrame } from "./components/SelfieFrame";
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
import { useFinishMoment } from "./useFinishMoment";
import { useFocusedFieldInView } from "./useFocusedFieldInView";
import { usePhoneStep } from "./usePhoneStep";
import { usePhotoStep } from "./usePhotoStep";
import { useHomeStep, useNameStep } from "./useSignUpSteps";

/** The page's side margin: the card is as wide as the content, up to its design width. */
const GUTTER = 16;
/** Room kept under a focused field above the keyboard: its hint or error line. */
const FIELD_FOOTER = 28;

/**
 * Sign-up as one screen (#250 §1, #292): a progress bar, the ID card filling in as the person
 * types, and one step's fields under it; once the phone is verified, the card alone in the middle
 * of the page and the way into the app (#295). The entry is decided once, as the screen mounts:
 * the role chosen on the previous screen starts a new account; an account this device has not
 * finished signing up resumes at its first unfinished step, or on the finished card when nothing
 * is left to answer.
 */
export function SignUpScreen() {
  const { role } = useLocalSearchParams<{ role?: string }>();
  const { user, onboardingUserId } = useSession();
  const [entry] = useState(() => signUpEntry(role, user, onboardingUserId));
  if (entry === null) return <Redirect href="/(auth)/role" />;
  return <SignUpFlow role={entry.role} firstStep={entry.step} />;
}

/** What the step area shows: a step, or the phone step's second pane, the code. */
type Pane = SignUpStep | "code";

const LAST_STEP = SIGN_UP_STEPS[SIGN_UP_STEPS.length - 1];

const failureOf = (message: string | null) =>
  message ? { message, highlight: [], offerLogin: false } : null;

/** Out of the way: no taps, nothing for assistive technology. */
const hiddenProps = (hidden: boolean) =>
  ({
    pointerEvents: hidden ? "none" : "auto",
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? "no-hide-descendants" : "auto",
  }) as const;

function SignUpFlow({ role, firstStep }: { role: SignUpRole; firstStep: SignUpStep | null }) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { status, user } = useSession();
  const [step, setStep] = useState<SignUpStep>(firstStep ?? LAST_STEP);
  const [direction, setDirection] = useState<1 | -1>(1);
  // "Let's go" was pressed: the flow is over and the app opens.
  const [done, setDone] = useState(false);
  // The session generation the last step was saved in (or the one resumed with every step
  // answered): "Let's go" ends the flow for that session only.
  const [finishedIn, setFinishedIn] = useState<number | null>(() =>
    firstStep === null ? sessionGeneration() : null,
  );
  // A step is sliding in: its action and Back wait for it, so a second tap meant for the step that
  // left never submits or validates the one arriving.
  const [moving, setMoving] = useState(false);
  const headings = useRef<Partial<Record<Pane, ComponentRef<typeof Text> | null>>>({});
  const firstFields = useRef<Partial<Record<Pane, InputHandle | null>>>({});
  const lastName = useRef<InputHandle>(null);
  const finishHeading = useRef<ComponentRef<typeof Text>>(null);
  // The ref on its own: an object holding one reads as a ref value during render.
  const { ref: scrollRef, ...scrollProps } = useFocusedFieldInView(FIELD_FOOTER);
  const index = SIGN_UP_STEPS.indexOf(step);
  const finishMoment = useFinishMoment(
    firstStep === null,
    useCallback(() => moveAccessibilityFocus(finishHeading.current), []),
  );
  const { stage, finish } = finishMoment;

  const slide = useCallback((towards: 1 | -1) => {
    setDirection(towards);
    setMoving(true);
  }, []);

  const advanceFrom = useCallback(
    (answered: SignUpStep) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      const next = SIGN_UP_STEPS[SIGN_UP_STEPS.indexOf(answered) + 1];
      if (next === undefined) {
        // The keyboard goes down and the page back to its top: the card takes the middle of it.
        Keyboard.dismiss();
        scrollRef.current?.scrollTo({ y: 0 });
        setFinishedIn(sessionGeneration());
        finish();
        return;
      }
      slide(1);
      setStep(next);
    },
    [finish, scrollRef, slide],
  );

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
  const photo = usePhotoStep(useCallback(() => advanceFrom("photo"), [advanceFrom]));
  const phone = usePhoneStep(
    useCallback(() => slide(1), [slide]),
    useCallback(() => advanceFrom("phone"), [advanceFrom]),
  );
  const pane: Pane = step === "phone" && phone.pane === "code" ? "code" : step;
  const submit = {
    account: account.submitForm,
    name: name.submit,
    home: home.submit,
    photo: photo.action.run,
    phone: phone.action.run,
  }[step];
  const busy = {
    account: account.submitting,
    name: name.submitting,
    home: home.submitting,
    photo: photo.submitting || photo.capturing,
    phone: phone.number.sending || phone.code.verifying || phone.code.resending,
  }[step];

  // Past the account step the session belongs to the flow; a session that ends meanwhile (expired,
  // refused) sends the person back to Welcome, signed out.
  // A flow finished by a session that is gone since is not finished for this one.
  const ending =
    done && finishedIn !== null && isCurrentGeneration(finishedIn)
      ? "done"
      : index >= 1 && status === "signedOut"
        ? "sessionLost"
        : null;

  // The code goes back to its number, kept as typed.
  const changeNumber = () => {
    if (busy || moving) return;
    slide(-1);
    phone.changeNumber();
  };
  const stepBack = () => {
    if (busy || moving || index < 2 || stage !== "steps") return;
    if (pane === "code") {
      changeNumber();
      return;
    }
    slide(-1);
    setStep(SIGN_UP_STEPS[index - 1]);
  };

  // Nothing leaves the flow once the account exists: Back goes a step back from step 2 on, and
  // does nothing on step 1 (the account is not un-created) or on the finished card. Nothing leaves
  // while the account is being created either: the session would arrive for a screen that is gone.
  usePreventRemove(ending === null && (index >= 1 || busy), stepBack);

  // After the commit that turned the guard off, so neither the gate's switch to the app nor the
  // way back to Welcome is blocked.
  useEffect(() => {
    if (ending === "done") void endOnboarding();
    if (ending === "sessionLost") router.dismissTo("/(auth)/welcome");
  }, [ending]);

  // Focus follows the step: a screen reader's to its heading, everyone else's to its first field.
  const onSettled = useCallback((settled: Pane) => {
    setMoving(false);
    moveAccessibilityFocus(headings.current[settled] ?? null);
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((readerOn) => {
        if (!readerOn) firstFields.current[settled]?.focus();
      })
      .catch(() => undefined);
  }, []);

  const heading = (key: Pane, title: string, support: string) => (
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

  const renderStep = (key: Pane) => {
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
      case "photo":
        return (
          <View className="gap-6">
            {heading(key, t("signUp.photo.title"), t("signUp.photo.support"))}
            <FormError failure={failureOf(photo.failure)} testID="sign-up-photo-error" />
            <SelfieFrame
              photo={photo}
              camera={photo.camera}
              active={step === "photo"}
              testID="sign-up-photo"
            />
          </View>
        );
      case "phone":
        return (
          <View className="gap-6">
            {heading(
              key,
              t("signUp.phone.title"),
              t("signUp.phone.support", { length: CODE_LENGTH }),
            )}
            <Input
              ref={(node) => {
                firstFields.current.phone = node;
              }}
              label={t("phone.numberLabel")}
              prefix={phoneConfig.countryCode}
              value={phone.number.text}
              onChangeText={phone.number.setText}
              error={phone.number.error ?? undefined}
              disabled={phone.number.sending}
              keyboardType="phone-pad"
              inputMode="tel"
              textContentType="telephoneNumber"
              autoComplete="tel"
              importantForAutofill="yes"
              returnKeyType="send"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={() => void phone.number.submit()}
              testID="sign-up-phone"
            />
          </View>
        );
      case "code":
        return (
          <View className="gap-6">
            {heading(
              key,
              t("signUp.code.title"),
              t("phone.codeSubtitle", { phone: phone.cardPhone }),
            )}
            <CodeInput
              ref={(node) => {
                firstFields.current.code = node;
              }}
              label={t("phone.codeLabel")}
              value={phone.code.code}
              onChangeText={phone.code.setCode}
              length={CODE_LENGTH}
              error={phone.code.error ?? undefined}
              testID="sign-up-code"
            />
            <View className="items-start gap-1">
              <Button
                label={
                  phone.code.resendIn > 0
                    ? t("phone.resendIn", { seconds: phone.code.resendIn })
                    : t("phone.resend")
                }
                variant="ghost"
                disabled={phone.code.resendIn > 0 || busy}
                loading={phone.code.resending}
                onPress={() => void phone.code.resend()}
                className="-ml-5"
                testID="sign-up-resend"
              />
              <Button
                label={t("phone.changeNumber")}
                variant="ghost"
                disabled={busy}
                onPress={changeNumber}
                className="-ml-5"
                testID="sign-up-change-number"
              />
            </View>
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
  // The number as it is typed; a flow reopened on the finished card shows the one verified.
  const cardPhone =
    phone.cardPhone ||
    (user?.phone_verified && user.phone ? formatE164(user.phone, phoneConfig.countryCode) : "");
  const onSteps = stage === "steps";
  const showBack = onSteps && (index === 0 || index >= 2);
  const actionLabel = !onSteps
    ? t("signUp.finish.continue")
    : step === "account"
      ? t("signUp.submit")
      : step === "photo"
        ? photo.action.label
        : step === "phone"
          ? t(pane === "code" ? "phone.verify" : "phone.send")
          : t("signUp.next");

  const onAction = () => {
    if (stage === "finished") setDone(true);
    else if (onSteps && !moving) void submit();
  };

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
          ref={scrollRef}
          {...scrollProps}
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          testID="sign-up-scroll"
        >
          {/* The row keeps its height on step 2, which has no way back: nothing below moves. Two
              views: the animated fade would override the row's own opacity. */}
          <Animated.View style={finishMoment.stepsStyle}>
            <View
              style={{ opacity: showBack ? 1 : 0 }}
              {...hiddenProps(!showBack)}
              testID="sign-up-back-row"
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
          </Animated.View>
          <Animated.View style={finishMoment.stepsStyle} {...hiddenProps(!onSteps)}>
            <FlowProgress
              completed={onSteps ? index : SIGN_UP_STEPS.length}
              total={SIGN_UP_STEPS.length}
              label={t("signUp.progress", { step: index + 1, total: SIGN_UP_STEPS.length })}
              testID="sign-up-progress"
            />
          </Animated.View>
          {stage === "finished" ? (
            // Laid over the page, so it moves nothing; it sits right above the card's new place.
            <Animated.View
              style={[styles.headline, finishMoment.headlineStyle]}
              onLayout={finishMoment.onHeadlineLayout}
              testID="sign-up-finish"
            >
              <Text
                ref={finishHeading}
                accessibilityRole="header"
                className="text-center text-title-2 text-navy-900"
              >
                {t("signUp.finish.title")}
              </Text>
              <Text className="text-center text-callout text-gray-500">
                {t("signUp.finish.support")}
              </Text>
            </Animated.View>
          ) : null}
          <Animated.View
            className="items-center"
            style={finishMoment.cardStyle}
            onLayout={finishMoment.onCardLayout}
          >
            <IdCard
              variant={role}
              width={Math.min(ID_CARD_BASE_WIDTH, width - GUTTER * 2)}
              name={cardName}
              city={home.fields.city.trim()}
              state={home.fields.state.trim()}
              phone={cardPhone}
              photoUri={photo.photoUri}
              publicCode={user?.public_code}
              interactive
              testID="sign-up-card"
            />
          </Animated.View>
          {stage === "finished" ? null : (
            <Animated.View style={finishMoment.stepsStyle} {...hiddenProps(!onSteps)}>
              <StepSlider
                stepKey={pane}
                direction={direction}
                renderStep={renderStep}
                onSettled={onSettled}
                gutter={GUTTER}
                testID="sign-up-step"
              />
            </Animated.View>
          )}
          <Animated.View className="flex-1" style={finishMoment.spacerStyle} />
          <Animated.View
            style={finishMoment.actionStyle}
            onLayout={finishMoment.onActionLayout}
            {...hiddenProps(stage === "leaving")}
          >
            <Button
              label={actionLabel}
              size="lg"
              loading={onSteps && busy}
              disabled={
                onSteps &&
                ((step === "photo" && photo.action.disabled) ||
                  (step === "phone" && phone.action.disabled))
              }
              onPress={onAction}
              testID="sign-up-screen-submit"
            />
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Its own width (an absolute child measures against the page): the page's gutters.
  headline: {
    position: "absolute",
    top: 0,
    left: GUTTER,
    right: GUTTER,
    gap: 4,
    paddingBottom: 16,
  },
});
