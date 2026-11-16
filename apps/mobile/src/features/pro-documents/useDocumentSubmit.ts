import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { announce } from "@/components/ui";
import { useSinglePhoto, type SinglePhoto } from "@/features/media";

import { documentFailure, useSubmitDocument, type DocumentFailure } from "./api";
import {
  expiryError,
  expiryIsoOf,
  maskDate,
  takesExpiry,
  type DocumentType,
  type ExpiryError,
} from "./documents";

/** The "Camera or library" sheet of the documents' stack. */
const SOURCE_SHEET = "/pro/documents/media-source";

export type DocumentSubmit = {
  /** The document's photo: one picture, uploaded as soon as it is chosen. */
  photo: SinglePhoto;
  /** The expiry date as typed, MM/DD/YYYY; always empty for a type that has none. */
  expiry: string;
  setExpiry: (text: string) => void;
  /** Shown once Submit was pressed, then as the fields change. */
  errors: { photo?: "required"; expiry?: ExpiryError };
  failure: DocumentFailure | null;
  submitting: boolean;
  submit: () => Promise<void>;
};

/**
 * Submitting one document: its photo (`pro_document`, uploaded when chosen), an optional expiry
 * date for a license or an insurance policy (today or later), then one POST for the session
 * Submit was pressed in. A photo the API refuses is set aside and the date stays. `onSubmitted`
 * runs once the server has the document, while the screen is still mounted and its session
 * current.
 */
export function useDocumentSubmit({
  type,
  onSubmitted,
}: {
  type: DocumentType;
  onSubmitted: () => void;
}): DocumentSubmit {
  const { t } = useTranslation();
  const send = useSubmitDocument();
  // An ID, a license or an insurance policy: the app's copies of the photo leave the phone as soon
  // as nothing needs them (on the storage, set aside, the screen left, the account changed).
  const photo = useSinglePhoto({
    purpose: "pro_document",
    sourceSheet: SOURCE_SHEET,
    discardFiles: true,
  });
  const [expiry, setExpiryText] = useState("");
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<DocumentFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dated = takesExpiry(type);
  const invalid = {
    ...(photo.key === null && !photo.busy ? { photo: "required" as const } : {}),
    ...(dated && expiryError(expiry) ? { expiry: expiryError(expiry) } : {}),
  };

  const submit = async () => {
    // Not while the photo is on its way, nor while its sheet or the picker is opening.
    if (submitting || photo.busy || photo.choosing) return;
    setChecked(true);
    if (photo.key === null || invalid.expiry) {
      announce(t("proDocuments.submit.check"));
      return;
    }
    const expiresOn = dated ? expiryIsoOf(expiry) : null;
    const generation = sessionGeneration();
    setFailure(null);
    setSubmitting(true);
    try {
      await send.mutateAsync({
        body: {
          doc_type: type,
          file_key: photo.key,
          ...(expiresOn ? { expires_on: expiresOn } : {}),
        },
        generation,
      });
    } catch (error) {
      if (!mounted.current || !isCurrentGeneration(generation)) return;
      setSubmitting(false);
      const reason = documentFailure(error);
      // The photo the API refused cannot be sent again.
      if (reason === "photo") {
        photo.discard();
        // The notice says to choose another: "add a photo first" under it would say it twice.
        setChecked(false);
      }
      setFailure(reason);
      announce(t(`proDocuments.submit.failed.${reason}`));
      return;
    }
    // Still submitting: the button stays busy while the screen leaves.
    if (!mounted.current || !isCurrentGeneration(generation)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    announce(t("proDocuments.submit.sent"));
    onSubmitted();
  };

  return {
    photo,
    expiry,
    setExpiry: (text) => setExpiryText(maskDate(text)),
    errors: checked ? invalid : {},
    failure,
    submitting,
    submit,
  };
}
