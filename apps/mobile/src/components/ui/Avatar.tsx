import { useState } from "react";
import { Image, Text, View } from "react-native";

import { cx } from "./cx";

export type AvatarSize = "sm" | "md" | "lg";

export type AvatarProps = {
  /** The person name: the accessible label and the source of the initials. */
  name: string;
  imageUri?: string;
  size?: AvatarSize;
  testID?: string;
};

// Diameters on the 4-pt grid; the initials take the type style that fits each circle (md: headline).
const DIAMETER: Record<AvatarSize, number> = { sm: 32, md: 48, lg: 72 };
const INITIALS_TYPE: Record<AvatarSize, string> = {
  sm: "text-caption",
  md: "text-headline",
  lg: "text-title-2",
};

/** First letter of the first two words, uppercase: "maria lopez" gives "ML", "Jack" gives "J", blank gives "". */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => (Array.from(word)[0] ?? "").toUpperCase())
    .join("");
}

export function Avatar({ name, imageUri, size = "md", testID }: AvatarProps) {
  // Remembering which URI failed lets a new imageUri try again.
  const [failedUri, setFailedUri] = useState<string>();
  const diameter = DIAMETER[size];
  const dimension = { width: diameter, height: diameter };
  const showImage = Boolean(imageUri) && imageUri !== failedUri;
  const initials = initialsOf(name);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      testID={testID}
      className="items-center justify-center overflow-hidden rounded-pill bg-navy-700"
      style={dimension}
    >
      {showImage ? (
        <Image
          source={{ uri: imageUri }}
          onError={() => setFailedUri(imageUri)}
          style={dimension}
        />
      ) : initials ? (
        <Text className={cx("text-white", INITIALS_TYPE[size])}>{initials}</Text>
      ) : null}
    </View>
  );
}
