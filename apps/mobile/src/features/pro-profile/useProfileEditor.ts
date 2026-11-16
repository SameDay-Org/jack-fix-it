import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isCurrentGeneration, sessionGeneration } from "@/api";
import { announce } from "@/components/ui";
import { CATEGORIES_QUERY_KEY } from "@/features/home/useCategories";

import {
  profileFailure,
  SERVICE_AREAS_QUERY_KEY,
  useUpdateProProfile,
  type ProfileFailure,
} from "./api";
import { proProfileConfig } from "./config";
import {
  cityToggled,
  draftErrors,
  profilePatch,
  toggled,
  type DraftErrors,
  type ProfileDraft,
} from "./draft";
import { useProfilePhoto, type ProfilePhoto } from "./useProfilePhoto";

/** The ids the catalogs offer now: the active categories and ZIP codes. */
export type Offered = { categoryIds: readonly string[]; areaIds: readonly string[] };

export type ProfileEditor = {
  /** The form as it stands, holding only choices that are still offered. */
  draft: ProfileDraft;
  setBio: (bio: string) => void;
  setYears: (years: string) => void;
  toggleCategory: (id: string) => void;
  toggleArea: (id: string) => void;
  /** Switches a whole city: all of its ZIP codes, or none once all are in. */
  toggleCity: (cityIds: readonly string[]) => void;
  /** Whether these ZIP codes, added to the ones chosen, still fit under the limit. */
  areasFit: (cityIds: readonly string[]) => boolean;
  /** The profile holds as many categories (ZIP codes) as it may: no other one can be added. */
  categoriesFull: boolean;
  areasFull: boolean;
  photo: ProfilePhoto;
  /** Shown once Save was pressed, then as the fields change. */
  errors: DraftErrors;
  failure: ProfileFailure | null;
  saving: boolean;
  submit: () => Promise<void>;
};

/**
 * The profile form: the bio, the years, the categories, the ZIP codes and a new photo. Save
 * sends one PATCH with only what changed since the form opened (`profilePatch`), for the session
 * it was pressed in; with nothing changed it asks nothing. A photo that did not upload, or that
 * the API refuses, is set aside and everything typed stays. A choice the API no longer offers
 * reloads the catalogs, and what they dropped leaves the form. `onSaved` runs once the server
 * has the profile, while the form is still mounted and its session current.
 */
export function useProfileEditor({
  initial,
  offered,
  onSaved,
}: {
  /** The profile as the form opened with it (`draftOf`). */
  initial: ProfileDraft;
  offered: Offered;
  onSaved: () => void;
}): ProfileEditor {
  const { t } = useTranslation();
  const client = useQueryClient();
  const update = useUpdateProProfile();
  const photo = useProfilePhoto();
  const [typed, setDraft] = useState(initial);
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<ProfileFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const draft: ProfileDraft = {
    ...typed,
    categoryIds: typed.categoryIds.filter((id) => offered.categoryIds.includes(id)),
    areaIds: typed.areaIds.filter((id) => offered.areaIds.includes(id)),
  };
  const { maxCategories, maxServiceAreas } = proProfileConfig;
  const change = (patch: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  /** Takes a new selection unless it grew past its limit. */
  const grows = (next: readonly string[], current: readonly string[], max: number) =>
    next.length > current.length && next.length > max;
  const selectCategories = (next: string[]) => {
    if (!grows(next, draft.categoryIds, maxCategories)) change({ categoryIds: next });
  };
  const selectAreas = (next: string[]) => {
    if (!grows(next, draft.areaIds, maxServiceAreas)) change({ areaIds: next });
  };

  const submit = async () => {
    // Not while the photo is on its way, nor while its sheet or the picker is opening over the form.
    if (saving || photo.busy || photo.choosing) return;
    setChecked(true);
    if (Object.keys(draftErrors(draft)).length > 0) {
      announce(t("proProfile.edit.check"));
      return;
    }
    const body = profilePatch(initial, draft, photo.key);
    if (Object.keys(body).length === 0) {
      onSaved();
      return;
    }
    const generation = sessionGeneration();
    setFailure(null);
    setSaving(true);
    try {
      await update.mutateAsync({ body, generation });
    } catch (error) {
      if (!mounted.current || !isCurrentGeneration(generation)) return;
      setSaving(false);
      const reason = profileFailure(error);
      // The photo the API refused cannot be sent again: the profile keeps the one it has.
      if (reason === "photo") photo.discard();
      if (reason === "choices") {
        void client.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
        void client.invalidateQueries({ queryKey: SERVICE_AREAS_QUERY_KEY });
      }
      setFailure(reason);
      announce(t(`proProfile.edit.failed.${reason}`));
      return;
    }
    // Still saving: the button stays busy while the form leaves.
    if (!mounted.current || !isCurrentGeneration(generation)) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    announce(t("proProfile.edit.saved"));
    onSaved();
  };

  return {
    draft,
    setBio: (bio) => change({ bio }),
    setYears: (years) => change({ years }),
    toggleCategory: (id) => selectCategories(toggled(draft.categoryIds, id)),
    toggleArea: (id) => selectAreas(toggled(draft.areaIds, id)),
    toggleCity: (cityIds) => selectAreas(cityToggled(draft.areaIds, cityIds)),
    areasFit: (cityIds) =>
      !grows(cityToggled(draft.areaIds, cityIds), draft.areaIds, maxServiceAreas),
    categoriesFull: draft.categoryIds.length >= maxCategories,
    areasFull: draft.areaIds.length >= maxServiceAreas,
    photo,
    errors: checked ? draftErrors(draft) : {},
    failure,
    saving,
    submit,
  };
}
