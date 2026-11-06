import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Input, type InputHandle } from "@/components/ui";

import { ADDRESS_MAX, type AddressError, type AddressErrors, type AddressFields } from "./addressFields";

export type AddressFormProps = {
  fields: AddressFields;
  errors: AddressErrors;
  onChange: (field: keyof AddressFields, value: string) => void;
  /** The server answered "not in this area" for this ZIP. */
  zipRefused?: boolean;
  disabled?: boolean;
  /** The street field takes focus as the form mounts. */
  autoFocus?: boolean;
  /** A heading over the fields, when the form sits under other choices. */
  title?: string;
  /** The ZIP field's return key: the form's one action. */
  onSubmitEditing?: () => void;
  /** Prefixes every field's id: `${testID}-line1` and so on. */
  testID: string;
};

/**
 * A US address: street, unit (optional), city, then state and ZIP side by side. Return moves down
 * the fields and the last one hands over to `onSubmitEditing`. The state is typed in capitals
 * and the ZIP keeps digits only.
 */
export function AddressForm({
  fields,
  errors,
  onChange,
  zipRefused = false,
  disabled = false,
  autoFocus = false,
  title,
  onSubmitEditing,
  testID,
}: AddressFormProps) {
  const { t } = useTranslation();
  const line2 = useRef<InputHandle>(null);
  const city = useRef<InputHandle>(null);
  const state = useRef<InputHandle>(null);
  const zip = useRef<InputHandle>(null);
  const message = (error: AddressError | undefined, max?: number) =>
    error ? t(`address.errors.${error}`, { max }) : undefined;

  return (
    <View className="gap-4" testID={`${testID}-form`}>
      {title ? (
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {title}
        </Text>
      ) : null}
      <Input
        label={t("address.line1")}
        value={fields.line1}
        onChangeText={(value) => onChange("line1", value)}
        error={message(errors.line1, ADDRESS_MAX.line1)}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={ADDRESS_MAX.line1}
        autoComplete="address-line1"
        textContentType="streetAddressLine1"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => line2.current?.focus()}
        testID={`${testID}-line1`}
      />
      <Input
        ref={line2}
        label={t("common.optionalLabel", { label: t("address.line2") })}
        value={fields.line2}
        onChangeText={(value) => onChange("line2", value)}
        error={message(errors.line2, ADDRESS_MAX.line2)}
        disabled={disabled}
        maxLength={ADDRESS_MAX.line2}
        autoComplete="address-line2"
        textContentType="streetAddressLine2"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => city.current?.focus()}
        testID={`${testID}-line2`}
      />
      <Input
        ref={city}
        label={t("address.city")}
        value={fields.city}
        onChangeText={(value) => onChange("city", value)}
        error={message(errors.city, ADDRESS_MAX.city)}
        disabled={disabled}
        maxLength={ADDRESS_MAX.city}
        textContentType="addressCity"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => state.current?.focus()}
        testID={`${testID}-city`}
      />
      <View className="flex-row gap-3">
        <Input
          ref={state}
          label={t("address.state")}
          value={fields.state}
          onChangeText={(value) => onChange("state", value.toUpperCase())}
          error={message(errors.state)}
          disabled={disabled}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={2}
          textContentType="addressState"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => zip.current?.focus()}
          className="flex-1"
          testID={`${testID}-state`}
        />
        <Input
          ref={zip}
          label={t("address.zip")}
          value={fields.zipCode}
          onChangeText={(value) => onChange("zipCode", value.replace(/[^0-9]/g, ""))}
          error={message(errors.zipCode)}
          invalid={zipRefused}
          disabled={disabled}
          keyboardType="number-pad"
          autoComplete="postal-code"
          textContentType="postalCode"
          maxLength={5}
          returnKeyType={onSubmitEditing ? "done" : undefined}
          submitBehavior={onSubmitEditing ? "submit" : undefined}
          onSubmitEditing={onSubmitEditing}
          className="flex-1"
          testID={`${testID}-zip`}
        />
      </View>
    </View>
  );
}
