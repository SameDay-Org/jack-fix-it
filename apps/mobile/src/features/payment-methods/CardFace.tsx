import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

import { bubbleShadow, continuousCorners, tokens, type ColorToken } from "@/theme";

import { BrandMark, type BrandMarkTone } from "./BrandMark";
import {
  ageOf,
  brandOf,
  expiryOf,
  maskedNumber,
  spokenCard,
  walletOrder,
  type SavedCard,
  type Wallet,
} from "./cards";

/** A card's colors: its surface, the ink of everything written on it, and its brand mark's tile. */
export type CardTone = { surface: ColorToken; ink: ColorToken; mark: BrandMarkTone };

// White, lime and deep green over the navy wallet. Every ink is AA on its surface at text size.
const TONES: readonly CardTone[] = [
  { surface: "white", ink: "navy-900", mark: "dark" },
  { surface: "green-500", ink: "navy-900", mark: "dark" },
  { surface: "green-700", ink: "white", mark: "light" },
];

/**
 * The tone of a card of this `age` (`ageOf`, 0 for the oldest): the same whichever card is the
 * default. The pocket and an opened card draw `stackTone`, which shifts one card's tone.
 */
export const cardTone = (age: number): CardTone => TONES[Math.max(age, 0) % TONES.length];

/**
 * A card's tone in the pocket's stack (`walletOrder`: the default in front, then the newest
 * first): its own by age, except the card right behind the front one, which takes the next tone
 * when it would match the front card's (the oldest card as the default, with a multiple of three
 * cards after it). Any other two neighbours are a card apart in age, or two: never the same tone.
 */
export function stackTone(wallet: Wallet, card: Pick<SavedCard, "id">): CardTone {
  const age = ageOf(wallet, card);
  const [front, behind] = walletOrder(wallet);
  const clashes = behind?.id === card.id && cardTone(age) === cardTone(ageOf(wallet, front));
  return cardTone(clashes ? age + 1 : age);
}

/** The card's height at the smallest font; it grows with what is written on it. */
const FACE_MIN_HEIGHT = 168;

/** The Default mark of a card: a pill in the card's ink, lettered in its surface. */
export function DefaultMark({ tone, testID }: { tone: CardTone; testID?: string }) {
  const { t } = useTranslation();
  return (
    <View
      className="rounded-pill px-2 py-0.5"
      style={{ backgroundColor: tokens.colors[tone.ink] }}
      testID={testID}
    >
      <Text className="text-caption font-semibold" style={{ color: tokens.colors[tone.surface] }}>
        {t("paymentMethods.default")}
      </Text>
    </View>
  );
}

export type CardFaceProps = { card: SavedCard; tone: CardTone; testID?: string };

/**
 * A saved card, opened: its brand, the masked number, the expiry and whether it is the default.
 * That is all there is of it in the app. One element for a screen reader, with the full label.
 */
export function CardFace({ card, tone, testID }: CardFaceProps) {
  const { t } = useTranslation();
  const ink = { color: tokens.colors[tone.ink] };
  return (
    <View
      accessible
      accessibilityLabel={spokenCard(t, card)}
      className="justify-between gap-6 rounded-lg p-5"
      style={[
        bubbleShadow,
        continuousCorners,
        { minHeight: FACE_MIN_HEIGHT, backgroundColor: tokens.colors[tone.surface] },
      ]}
      testID={testID}
    >
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <View className="shrink flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <BrandMark brand={brandOf(card)} tone={tone.mark} />
          <Text className="shrink text-headline" style={ink}>
            {t(`paymentMethods.brand.${brandOf(card)}`)}
          </Text>
        </View>
        {card.is_default ? <DefaultMark tone={tone} testID="card-face-default" /> : null}
      </View>
      <View className="gap-1">
        <Text className="text-title-2" style={ink}>
          {maskedNumber(card)}
        </Text>
        <Text className="text-callout" style={ink}>
          {t("paymentMethods.expires", { expiry: expiryOf(card) })}
        </Text>
      </View>
    </View>
  );
}
