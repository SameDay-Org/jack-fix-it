import { router } from "expo-router";
import { useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, ScrollView, View } from "react-native";

import { Button, ChoiceCard, Notice, Skeleton } from "@/components/ui";
import { useSavedAddresses } from "@/features/addresses";
import { AddressForm } from "@/features/addresses/AddressForm";

import { addressErrors, addressLine, resolveAddress } from "./address";
import { chooseAddress, setTypedAddress, useRequestDraft } from "./requestDraft";
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
            onChange={setTypedAddress}
            zipRefused={notServed}
            // Under the saved addresses, the form gets its own heading.
            title={savedItems.length > 0 ? t("request.where.formTitle") : undefined}
            testID="where"
          />
        </View>
      ) : null}
    </StepScreen>
  );
}
