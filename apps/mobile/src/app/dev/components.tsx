// Dev-only gallery, unreachable outside __DEV__: the sample strings below are literal on purpose.
import { Redirect } from "expo-router";
import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Avatar,
  Button,
  Card,
  Input,
  Skeleton,
  StatusBadge,
  type StatusTone,
} from "@/components/ui";

const TONES: StatusTone[] = ["neutral", "info", "success", "warning", "danger", "brand"];

// 1x1 orange PNG: the image state needs no network. The .invalid host never resolves, so onError fires.
const SAMPLE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4lCUNAAPJAXjt1tnnAAAAAElFTkSuQmCC";
const BROKEN_IMAGE = "https://images.invalid/missing.png";

function noop() {}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3">
      <Text className="text-lg font-semibold text-navy">{title}</Text>
      {children}
    </View>
  );
}

function Gallery() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [presses, setPresses] = useState(0);
  const bump = () => setPresses((count) => count + 1);

  return (
    <SafeAreaView className="flex-1 bg-gray-light" edges={["top", "bottom"]}>
      <ScrollView contentContainerClassName="gap-8 p-4" keyboardShouldPersistTaps="handled">
        <Text className="text-2xl font-semibold text-navy">UI components (dev)</Text>

        <Section title="Button">
          <Button label="Primary md" onPress={bump} />
          <Button label="Primary lg" size="lg" onPress={bump} />
          <Button label="Secondary" variant="secondary" onPress={bump} />
          <Button label="Ghost" variant="ghost" onPress={bump} />
          <Button label="Disabled" disabled onPress={bump} />
          <Button label="Loading" loading onPress={bump} />
          <Button label="Secondary loading" variant="secondary" loading onPress={bump} />
          <Text className="text-sm text-gray">Presses: {presses}</Text>
        </Section>

        <Section title="Input">
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            hint="We never share it"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          <Input
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
          />
          <Input
            label="ZIP code"
            value="9021"
            onChangeText={noop}
            error="Enter the 5 digits"
            keyboardType="number-pad"
          />
          <Input label="Disabled" value="Read only" onChangeText={noop} disabled />
        </Section>

        <Section title="Card">
          <Card>
            <Text className="text-base text-navy">Static card</Text>
          </Card>
          <Card onPress={bump} accessibilityLabel="Pressable card">
            <Text className="text-base text-navy">Pressable card</Text>
          </Card>
        </Section>

        <Section title="Avatar">
          <View className="flex-row items-center gap-4">
            <Avatar name="Maria Lopez" size="sm" />
            <Avatar name="Maria Lopez" />
            <Avatar name="Maria Lopez" size="lg" />
            <Avatar name="Jack" />
          </View>
          <View className="flex-row items-center gap-4">
            <Avatar name="   " />
            <Avatar name="With image" imageUri={SAMPLE_IMAGE} />
            <Avatar name="Broken image" imageUri={BROKEN_IMAGE} />
          </View>
        </Section>

        <Section title="StatusBadge">
          <View className="flex-row flex-wrap gap-2">
            {TONES.map((tone) => (
              <StatusBadge key={tone} label={tone} tone={tone} />
            ))}
          </View>
        </Section>

        <Section title="Skeleton">
          <Skeleton />
          <Skeleton width="60%" height={24} radius={12} />
          <Skeleton circle height={48} />
          <Card>
            <View className="flex-row items-center gap-3">
              <Skeleton circle height={48} />
              <View className="flex-1 gap-2">
                <Skeleton width="70%" />
                <Skeleton width="40%" height={12} />
              </View>
            </View>
          </Card>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function ComponentsGalleryScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Gallery />;
}
