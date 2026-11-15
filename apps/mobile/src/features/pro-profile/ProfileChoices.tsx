import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { Button, Chip } from "@/components/ui";
import { categoryName, type Category } from "@/features/home/useCategories";

import type { ServiceCity, ServiceRegion } from "./api";

type SectionProps = {
  title: string;
  support: string;
  /** What is wrong with the choice, in red; read when it appears. */
  error?: string;
  /** A quiet line under the chips: how many are chosen, or that no more fit. */
  note?: string;
  children: ReactNode;
  testID: string;
};

/** A titled group of choices: the title, one supporting line, the chips, then a note or an error. */
function Section({ title, support, error, note, children, testID }: SectionProps) {
  return (
    <View className="gap-3" testID={testID}>
      <View className="gap-1">
        <Text accessibilityRole="header" className="text-headline text-navy-900">
          {title}
        </Text>
        <Text className="text-callout text-gray-500">{support}</Text>
      </View>
      {children}
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-footnote text-danger"
          testID={`${testID}-error`}
        >
          {error}
        </Text>
      ) : note ? (
        <Text className="text-footnote text-gray-500" testID={`${testID}-note`}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

export type CategoryChoicesProps = {
  /** The active categories, in the API's order. */
  categories: readonly Category[];
  selected: readonly string[];
  /** No other category fits: the ones not chosen are dimmed. */
  full: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
};

/** The categories the pro takes jobs in, as multi-select chips. */
export function CategoryChoices({
  categories,
  selected,
  full,
  disabled,
  onToggle,
}: CategoryChoicesProps) {
  const { t } = useTranslation();
  return (
    <Section
      title={t("proProfile.categories.title")}
      support={t("proProfile.categories.support")}
      note={full && selected.length < categories.length ? t("proProfile.limit") : undefined}
      testID="pro-profile-categories"
    >
      <View className="flex-row flex-wrap gap-2">
        {categories.map((category) => {
          const chosen = selected.includes(category.id);
          return (
            <Chip
              key={category.id}
              label={categoryName(category)}
              selected={chosen}
              disabled={disabled || (full && !chosen)}
              onPress={() => onToggle(category.id)}
              testID={`pro-profile-category-${category.slug}`}
            />
          );
        })}
      </View>
    </Section>
  );
}

export type AreaChoicesProps = {
  /** The active service areas: region, then city, then ZIP code. */
  regions: readonly ServiceRegion[];
  selected: readonly string[];
  full: boolean;
  disabled: boolean;
  /** Save was pressed with no ZIP code chosen. */
  required: boolean;
  onToggle: (id: string) => void;
  onToggleCity: (cityIds: readonly string[]) => void;
  /** Whether a city's ZIP codes can all be chosen without passing the limit. */
  cityFits: (cityIds: readonly string[]) => boolean;
};

/** The ZIP codes the pro takes jobs in: a chip per code, grouped by city under its region. */
export function AreaChoices({ regions, selected, required, full, ...rest }: AreaChoicesProps) {
  const { t } = useTranslation();
  return (
    <Section
      title={t("proProfile.areas.title")}
      support={t("proProfile.areas.support")}
      error={required ? t("proProfile.areas.required") : undefined}
      note={full ? t("proProfile.limit") : t("proProfile.areas.count", { count: selected.length })}
      testID="pro-profile-areas"
    >
      {regions.map((region) => (
        <View key={region.region} className="gap-4">
          <Text className="text-callout font-semibold text-navy-900">{region.region}</Text>
          {region.cities.map((city) => (
            <CityChoices
              key={`${city.city}-${city.state}`}
              city={city}
              selected={selected}
              full={full}
              {...rest}
            />
          ))}
        </View>
      ))}
    </Section>
  );
}

type CityChoicesProps = Omit<AreaChoicesProps, "regions" | "required"> & { city: ServiceCity };

/** One city: its name, "Select all" (or "Clear" once all are in) when it has several, its codes. */
function CityChoices({
  city,
  selected,
  full,
  disabled,
  onToggle,
  onToggleCity,
  cityFits,
}: CityChoicesProps) {
  const { t } = useTranslation();
  const ids = city.zips.map((zip) => zip.id);
  const all = ids.every((id) => selected.includes(id));

  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-center justify-between gap-x-3">
        <Text className="shrink text-callout text-navy-900">{city.city}</Text>
        {ids.length > 1 ? (
          <Button
            label={t(all ? "proProfile.areas.clear" : "proProfile.areas.selectAll")}
            accessibilityLabel={t(
              all ? "proProfile.areas.clearCity" : "proProfile.areas.selectCity",
              { city: city.city },
            )}
            variant="ghost"
            disabled={disabled || !cityFits(ids)}
            onPress={() => onToggleCity(ids)}
            className="-mr-5"
            testID={`pro-profile-city-${city.city}`}
          />
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {city.zips.map((zip) => {
          const chosen = selected.includes(zip.id);
          return (
            <Chip
              key={zip.id}
              label={zip.zip_code}
              hint={city.city}
              selected={chosen}
              disabled={disabled || (full && !chosen)}
              onPress={() => onToggle(zip.id)}
              testID={`pro-profile-zip-${zip.zip_code}`}
            />
          );
        })}
      </View>
    </View>
  );
}
