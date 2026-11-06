import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, NetworkError, useSession } from "@/api";
import { announce } from "@/components/ui/focus";
import { useUpdateMe } from "@/features/account/api";
import { useSaveAddress } from "@/features/addresses";
import {
  ADDRESS_MAX,
  EMPTY_ADDRESS_FIELDS,
  savedAddressInput,
  type AddressErrors,
  type AddressFields,
} from "@/features/addresses/addressFields";

import {
  HOME_CITY_MAX,
  homeErrors,
  NAME_MAX,
  nameErrors,
  tidyName,
  type NameErrors,
  type NameFields,
} from "./signUpSteps";
import type { SignUpRole } from "./roles";

/** A step's form: its fields, what is wrong with them, and its one action. */
export type StepForm<Fields, Errors> = {
  fields: Fields;
  set: (field: keyof Fields, value: string) => void;
  /** The fields' own problems, shown once the person tried to go on. */
  errors: Errors;
  /** The server refused the fields as typed: they get the danger ring with `failure`. */
  refused: boolean;
  /** What went wrong with the save, in the app's language. */
  failure: string | null;
  submitting: boolean;
  submit: () => Promise<void>;
};

type FailureKey =
  | "signUp.errors.nameInvalid"
  | "signUp.errors.nameSave"
  | "signUp.errors.homeInvalid"
  | "signUp.errors.homeSave";

/** A save that failed: the connection, the rate limit, or the step's own line. A raw server message is never shown. */
export function failureKey<Key extends string>(
  error: unknown,
  fallback: Key,
): Key | "auth.errors.offline" | "auth.errors.rateLimited" {
  if (error instanceof NetworkError) return "auth.errors.offline";
  if (error instanceof ApiError && error.status === 429) return "auth.errors.rateLimited";
  return fallback;
}

const isRefusal = (error: unknown): boolean => error instanceof ApiError && error.status === 422;

/**
 * The state every step form shares: one save at a time (a ref, so two taps in the same turn
 * cannot both start one), its failure announced, and the fields' errors once checked.
 */
function useStepForm<Fields extends object, Errors extends object>(
  initial: Fields,
  validate: (fields: Fields) => Errors,
  messageOf: (errors: Errors) => string | undefined,
  save: (fields: Fields) => Promise<void>,
  invalidKey: FailureKey,
  saveKey: FailureKey,
): StepForm<Fields, Errors> {
  const { t } = useTranslation();
  const [fields, setFields] = useState(initial);
  const [checked, setChecked] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const set = useCallback((field: keyof Fields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    setRefused(false);
    setFailure(null);
  }, []);

  const submit = useCallback(async () => {
    if (inFlight.current) return;
    const errors = validate(fields);
    const firstError = messageOf(errors);
    if (firstError) {
      setChecked(true);
      announce(firstError);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await save(fields);
    } catch (error) {
      const message = t(isRefusal(error) ? invalidKey : failureKey(error, saveKey));
      setRefused(isRefusal(error));
      setFailure(message);
      announce(message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [fields, invalidKey, messageOf, save, saveKey, t, validate]);

  return {
    fields,
    set,
    errors: checked ? validate(fields) : ({} as Errors),
    refused,
    failure,
    submitting,
    submit,
  };
}

/**
 * Step 1: first and last name, typed live into the card, saved with PATCH /v1/auth/me (#165).
 * Names the account already holds go on without a request. `onSaved` moves the flow on.
 */
export function useNameStep(onSaved: () => void): StepForm<NameFields, NameErrors> {
  const { t } = useTranslation();
  const { user } = useSession();
  const { mutateAsync: updateMe } = useUpdateMe();
  const save = useCallback(
    async (fields: NameFields) => {
      const first_name = tidyName(fields.first);
      const last_name = tidyName(fields.last);
      if (user?.first_name !== first_name || user.last_name !== last_name) {
        await updateMe({ first_name, last_name });
      }
      onSaved();
    },
    [onSaved, updateMe, user],
  );
  const messageOf = useCallback(
    (errors: NameErrors) => {
      const error = errors.first ?? errors.last;
      return error ? t(`address.errors.${error}`, { max: NAME_MAX }) : undefined;
    },
    [t],
  );
  return useStepForm(
    { first: user?.first_name ?? "", last: user?.last_name ?? "" },
    nameErrors,
    messageOf,
    save,
    "signUp.errors.nameInvalid",
    "signUp.errors.nameSave",
  );
}

/** The most characters each home field takes: the card's city is shorter than an address's. */
const HOME_MAX: Partial<Record<keyof AddressFields, number>> = {
  ...ADDRESS_MAX,
  city: HOME_CITY_MAX,
};

/**
 * Step 2: where the person lives. The card shows the city and state, saved with PATCH
 * /v1/auth/me. A customer types a whole address, saved first as their default address named
 * "Home" (an address of that name already saved, by an earlier try, is kept as it is); a pro types
 * the city and state alone.
 */
export function useHomeStep(
  role: SignUpRole,
  onSaved: () => void,
): StepForm<AddressFields, AddressErrors> {
  const { t } = useTranslation();
  const { user } = useSession();
  const { mutateAsync: updateMe } = useUpdateMe();
  const { mutateAsync: saveAddress } = useSaveAddress();
  const save = useCallback(
    async (fields: AddressFields) => {
      if (role === "customer") {
        try {
          await saveAddress(savedAddressInput(fields, t("signUp.home.label"), true));
        } catch (error) {
          // A full book (only an account that already kept addresses): the card still goes on;
          // the book is the customer's to edit later.
          if (!(error instanceof ApiError && error.code === "address_limit_reached")) throw error;
        }
      }
      await updateMe({
        home_city: fields.city.trim(),
        home_state: fields.state.trim().toUpperCase(),
      });
      onSaved();
    },
    [onSaved, role, saveAddress, t, updateMe],
  );
  const validate = useCallback((fields: AddressFields) => homeErrors(fields, role), [role]);
  const messageOf = useCallback(
    (errors: AddressErrors) => {
      const field = (["line1", "line2", "city", "state", "zipCode"] as const).find(
        (key) => errors[key],
      );
      const error = field && errors[field];
      return error ? t(`address.errors.${error}`, { max: HOME_MAX[field] }) : undefined;
    },
    [t],
  );
  return useStepForm(
    { ...EMPTY_ADDRESS_FIELDS, city: user?.home_city ?? "", state: user?.home_state ?? "" },
    validate,
    messageOf,
    save,
    "signUp.errors.homeInvalid",
    "signUp.errors.homeSave",
  );
}
