import { router } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ScrollView, Text, View } from "react-native";

import { Button, ChoiceCard, Input, Notice, Skeleton, type InputHandle } from "@/components/ui";
import { useSavedAddresses } from "@/features/addresses";

import {
  ADDRESS_MAX,
  addressErrors,
  addressLine,
  resolveAddress,
  type AddressError,
} from "./address";
import {
  chooseAddress,
  setTypedAddress,
  useRequestDraft,
  type AddressFields,
} from "./requestDraft";
import { StepScreen } from "./StepScreen";
import { nextStep, stepHref, type StepId } from "./steps";

// Saved addresses are at most four (#214); two placeholder rows hold the place while they load.
const SKELETON_ROWS = 2;
// Space kept above the form when "Use another address" scrolls to it (the step's gap-6).
const FORM_GAP = 24;

/**
 * Where the job is. The customer's saved addresses come first as choices (the default one picked,
 * addresses outside the service areas shown but not offered), then "Use another address", which
 * opens the form and scrolls to it; with none saved, the form alone. When the server answered "not in this area",
 * the step says so on top and the customer picks or types another address. When it refused the
 * typed address itself, the step says so too and marks the fields to fix.
 */
export function WhereStep({ steps }: { steps: readonly StepId[] }) {
  const { t } = useTranslation();
  const saved = useSavedAddresses();
  const choice = useRequestDraft((draft) => draft.address);
  const typed = useRequestDraft((draft) => draft.typedAddress);
  const notServed = useRequestDraft((draft) => draft.refusal?.reason === "zipNotServed");
  const addressRefused = useRequestDraft((draft) => draft.refusal?.reason === "invalidAddress");
  const [checked, setChecked] = useState(false);
  // Sent back from Review: the fields stay marked as the customer fixes them, as after Continue.
  if (addressRefused && !checked) setChecked(true);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // Set when "Use another address" opens the form: its first layout scrolls it into view.
  const revealForm = useRef(false);
  const savedItems = saved.data?.items ?? [];
  const resolved = resolveAddress(choice, saved.data?.items);
  const showForm = resolved.kind === "typed";
  const errors = checked && showForm ? addressErrors(typed) : {};

  const onContinue = () => {
    if (saved.isPending) return;
    if (showForm && Object.keys(addressErrors(typed)).length > 0) {
      setChecked(true);
      AccessibilityInfo.announceForAccessibility(t("request.where.check"));
      return;
    }
    const next = nextStep("where", steps);
    if (next) router.push(stepHref(next, steps));
  };

  return (
    <StepScreen
      step="where"
      steps={steps}
      title={t("request.where.title")}
      support={t("request.where.support")}
      action={
        <Button
          label={t("common.continue")}
          size="lg"
          disabled={saved.isPending}
          onPress={onContinue}
          testID="where-continue"
        />
      }
      scrollRef={scrollRef}
      refusal={
        notServed
          ? t("request.where.notServedTitle")
          : addressRefused
            ? t("request.where.invalidTitle")
            : undefined
      }
      testID="request-where"
    >
      {notServed ? (
        <Notice
          tone="danger"
          title={t("request.where.notServedTitle")}
          body={t("request.where.notServedBody")}
          testID="where-not-served"
        />
      ) : null}
      {addressRefused ? (
        <Notice
          tone="danger"
          title={t("request.where.invalidTitle")}
          body={t("request.where.invalidBody")}
          testID="where-invalid"
        />
      ) : null}
      {saved.isPending ? (
        <View
          accessible
          accessibilityLabel={t("common.loading")}
          className="gap-3"
          testID="where-loading"
        >
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-lg" />
          ))}
        </View>
      ) : null}
      {saved.isError ? (
        <Notice tone="info" title={t("request.where.savedFailed")} testID="where-saved-failed">
          <Button
            label={t("request.where.savedRetry")}
            variant="secondary"
            onPress={() => void saved.refetch()}
            testID="where-saved-retry"
          />
        </Notice>
      ) : null}
      {savedItems.length > 0 ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={t("request.where.savedLabel")}
          className="gap-3"
        >
          {savedItems.map((address) => (
            <ChoiceCard
              key={address.id}
              title={address.label}
              description={
                address.served
                  ? addressLine(address)
                  : t("request.where.savedNotServed", { address: addressLine(address) })
              }
              selected={resolved.kind === "saved" && resolved.address.id === address.id}
              disabled={!address.served}
              onPress={() => chooseAddress({ kind: "saved", id: address.id })}
              testID={`where-saved-${address.id}`}
            />
          ))}
          <ChoiceCard
            title={t("request.where.another")}
            selected={showForm}
            onPress={() => {
              revealForm.current = !showForm;
              chooseAddress({ kind: "typed" });
            }}
            testID="where-another"
          />
        </View>
      ) : null}
      {showForm && !saved.isPending ? (
        <View
          onLayout={({ nativeEvent }) => {
            if (!revealForm.current) return;
            revealForm.current = false;
            scrollRef.current?.scrollTo({ y: nativeEvent.layout.y - FORM_GAP, animated: true });
          }}
        >
          <AddressForm
            fields={typed}
            errors={errors}
            zipRefused={notServed}
            titled={savedItems.length > 0}
          />
        </View>
      ) : null}
    </StepScreen>
  );
}

type AddressFormProps = {
  fields: AddressFields;
  errors: Partial<Record<keyof AddressFields, AddressError>>;
  /** The server answered "not in this area" for this ZIP. */
  zipRefused: boolean;
  /** Under the saved addresses, the form gets its own heading. */
  titled: boolean;
};

/** A US address: street, unit (optional), city, then state and ZIP side by side. */
function AddressForm({ fields, errors, zipRefused, titled }: AddressFormProps) {
  const { t } = useTranslation();
  const line2 = useRef<InputHandle>(null);
  const city = useRef<InputHandle>(null);
  const state = useRef<InputHandle>(null);
  const zip = useRef<InputHandle>(null);
  const message = (error: AddressError | undefined, max?: number) =>
    error ? t(`request.where.errors.${error}`, { max }) : undefined;

  return (
    <View className="gap-4" testID="where-form">
      {titled ? (
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {t("request.where.formTitle")}
        </Text>
      ) : null}
      <Input
        label={t("request.where.line1")}
        value={fields.line1}
        onChangeText={(value) => setTypedAddress("line1", value)}
        error={message(errors.line1, ADDRESS_MAX.line1)}
        maxLength={ADDRESS_MAX.line1}
        autoComplete="address-line1"
        textContentType="streetAddressLine1"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => line2.current?.focus()}
        testID="where-line1"
      />
      <Input
        ref={line2}
        label={t("request.optionalLabel", { label: t("request.where.line2") })}
        value={fields.line2}
        onChangeText={(value) => setTypedAddress("line2", value)}
        error={message(errors.line2, ADDRESS_MAX.line2)}
        maxLength={ADDRESS_MAX.line2}
        autoComplete="address-line2"
        textContentType="streetAddressLine2"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => city.current?.focus()}
        testID="where-line2"
      />
      <Input
        ref={city}
        label={t("request.where.city")}
        value={fields.city}
        onChangeText={(value) => setTypedAddress("city", value)}
        error={message(errors.city, ADDRESS_MAX.city)}
        maxLength={ADDRESS_MAX.city}
        textContentType="addressCity"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => state.current?.focus()}
        testID="where-city"
      />
      <View className="flex-row gap-3">
        <Input
          ref={state}
          label={t("request.where.state")}
          value={fields.state}
          onChangeText={(value) => setTypedAddress("state", value.toUpperCase())}
          error={message(errors.state)}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={2}
          textContentType="addressState"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => zip.current?.focus()}
          className="flex-1"
          testID="where-state"
        />
        <Input
          ref={zip}
          label={t("request.where.zip")}
          value={fields.zipCode}
          onChangeText={(value) => setTypedAddress("zipCode", value.replace(/[^0-9]/g, ""))}
          error={message(errors.zipCode)}
          invalid={zipRefused}
          keyboardType="number-pad"
          autoComplete="postal-code"
          textContentType="postalCode"
          maxLength={5}
          className="flex-1"
          testID="where-zip"
        />
      </View>
    </View>
  );
}
