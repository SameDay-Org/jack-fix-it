import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo } from "react-native";

import { isCurrentGeneration, sessionGeneration, type PatchBody } from "@/api";

import {
  addressErrors,
  EMPTY_ADDRESS_FIELDS,
  LABEL_MAX,
  savedAddressInput,
  type AddressErrors,
  type AddressFields,
} from "./addressFields";
import { useCreateAddress, useUpdateAddress, type SavedAddress } from "./api";
import { addressFailure, isLabelTaken, type AddressFailure } from "./book";

/** Why the name cannot go: the form's own checks, then the server's refusals. */
export type LabelError = "required" | "tooLong" | "taken" | "invalid";

/** A failure the form shows above its button: the ones that are not about the name. */
export type FormFailure = Exclude<AddressFailure, "labelTaken" | "labelInvalid">;

/** A saved address as the form edits it. */
export const fieldsOf = (address: SavedAddress): AddressFields => ({
  line1: address.line1,
  line2: address.line2 ?? "",
  city: address.city,
  state: address.state,
  zipCode: address.zip_code,
});

function localLabelError(
  label: string,
  book: readonly SavedAddress[],
  exceptId: string | undefined,
): LabelError | undefined {
  const trimmed = label.trim();
  if (!trimmed) return "required";
  if (trimmed.length > LABEL_MAX) return "tooLong";
  if (isLabelTaken(book, trimmed, exceptId)) return "taken";
  return undefined;
}

type AddressPatch = PatchBody<"/v1/addresses/{address_id}">;

/** Every field as the form has it now; a cleared unit is sent as null so the API clears it. */
function patchOf(fields: AddressFields, label: string): AddressPatch {
  const { is_default: _isDefault, line2, ...rest } = savedAddressInput(fields, label, false);
  return { ...rest, line2: line2 ?? null };
}

const unchanged = (patch: AddressPatch, address: SavedAddress): boolean =>
  patch.label === address.label &&
  patch.line1 === address.line1 &&
  patch.line2 === address.line2 &&
  patch.city === address.city &&
  patch.state === address.state &&
  patch.zip_code === address.zip_code;

export type AddressEditor = {
  label: string;
  setLabel: (label: string) => void;
  fields: AddressFields;
  setField: (field: keyof AddressFields, value: string) => void;
  labelError: LabelError | undefined;
  errors: AddressErrors;
  failure: FormFailure | null;
  saving: boolean;
  submit: () => Promise<void>;
};

/**
 * The Add and Edit form of the address book: a name and the address. Its fields are checked when
 * Save is pressed, then as they change. A new address is not the default unless it is the first
 * (the API decides). `onSaved` runs once the server has the address, while the form is still
 * mounted and its session current.
 */
export function useAddressEditor({
  address,
  book,
  onSaved,
}: {
  /** The address being edited; none for a new one. */
  address?: SavedAddress;
  /** The book as cached, for the name check. */
  book: readonly SavedAddress[];
  onSaved: () => void;
}): AddressEditor {
  const { t } = useTranslation();
  const create = useCreateAddress();
  const update = useUpdateAddress();
  const [label, setLabelText] = useState(address?.label ?? "");
  const [fields, setFields] = useState<AddressFields>(
    address ? fieldsOf(address) : EMPTY_ADDRESS_FIELDS,
  );
  const [checked, setChecked] = useState(false);
  // The server's verdict on the name, until it changes.
  const [serverLabelError, setServerLabelError] = useState<LabelError | undefined>();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Not while saving: a new address joins the cached book before the form leaves, and would be
  // its own clash.
  const localError = saving ? undefined : localLabelError(label, book, address?.id);
  const labelError = checked ? (localError ?? serverLabelError) : serverLabelError;
  const errors = checked ? addressErrors(fields) : {};

  const setLabel = (text: string) => {
    setLabelText(text);
    setServerLabelError(undefined);
  };
  const setField = (field: keyof AddressFields, value: string) =>
    setFields((current) => ({ ...current, [field]: value }));

  const submit = async () => {
    if (saving) return;
    setChecked(true);
    if (localError || Object.keys(addressErrors(fields)).length > 0) {
      AccessibilityInfo.announceForAccessibility(t("addresses.form.check"));
      return;
    }
    const name = label.trim();
    const patch = address ? patchOf(fields, name) : undefined;
    if (address && patch && unchanged(patch, address)) {
      onSaved();
      return;
    }
    const generation = sessionGeneration();
    setFailure(null);
    setServerLabelError(undefined);
    setSaving(true);
    try {
      if (address && patch) await update.mutateAsync({ id: address.id, body: patch, generation });
      else await create.mutateAsync({ body: savedAddressInput(fields, name, false), generation });
    } catch (error) {
      if (!mounted.current || !isCurrentGeneration(generation)) return;
      setSaving(false);
      const reason = addressFailure(error);
      if (reason === "labelTaken" || reason === "labelInvalid") {
        setServerLabelError(reason === "labelTaken" ? "taken" : "invalid");
        AccessibilityInfo.announceForAccessibility(t("addresses.form.check"));
      } else {
        // `gone` only answers an edit; a new address has nothing to be gone.
        const shown: FormFailure = reason === "gone" && !address ? "generic" : reason;
        setFailure(shown);
        AccessibilityInfo.announceForAccessibility(t(`addresses.form.failed.${shown}`));
      }
      return;
    }
    // Still saving: the button stays busy while the form leaves.
    if (!mounted.current || !isCurrentGeneration(generation)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    AccessibilityInfo.announceForAccessibility(t("addresses.saved", { label: name }));
    onSaved();
  };

  return {
    label,
    setLabel,
    fields,
    setField,
    labelError,
    errors,
    failure,
    saving,
    submit,
  };
}
