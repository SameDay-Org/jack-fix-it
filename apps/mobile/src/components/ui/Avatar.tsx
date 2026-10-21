import { useState } from "react";
import { Image, Text, View } from "react-native";

export type AvatarSize = "sm" | "md" | "lg";

export type AvatarProps = {
  /** The person name: the accessible label and the source of the initials. */
  name: string;
  imageUri?: string;
  size?: AvatarSize;
  testID?: string;
};

const DIAMETER: Record<AvatarSize, number> = { sm: 32, md: 48, lg: 72 };
const FONT_SIZE: Record<AvatarSize, number> = { sm: 13, md: 18, lg: 28 };

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
      className="items-center justify-center overflow-hidden rounded-full bg-gray/20"
      style={dimension}
    >
      {showImage ? (
        <Image
          source={{ uri: imageUri }}
          onError={() => setFailedUri(imageUri)}
          style={dimension}
        />
      ) : initials ? (
        <Text className="font-semibold text-navy" style={{ fontSize: FONT_SIZE[size] }}>
          {initials}
        </Text>
      ) : null}
    </View>
  );
}
