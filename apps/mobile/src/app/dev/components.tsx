// Dev-only gallery, unreachable outside __DEV__: the sample strings below are literal on purpose.
import { Redirect, router } from "expo-router";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";

import { FloatingBar } from "@/components/dev/FloatingBar";
import { HeroSample } from "@/components/dev/HeroSample";
import {
  Avatar,
  Button,
  Card,
  GlassSurface,
  Input,
  Screen,
  Skeleton,
  StatusBadge,
  showToast,
  type StatusTone,
} from "@/components/ui";

const TONES: StatusTone[] = ["neutral", "info", "success", "warning", "danger", "brand"];

// 1x1 green-500 PNG: the image state needs no network. The .invalid host never resolves, so onError fires.
const SAMPLE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOI264NAAK3AUHeD95MAAAAAElFTkSuQmCC";
const BROKEN_IMAGE = "https://images.invalid/missing.png";

function noop() {}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3 px-4">
      <Text className="text-title-2 text-navy-900">{title}</Text>
      {children}
    </View>
  );
}

function Gallery() {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [presses, setPresses] = useState(0);
  const bump = () => setPresses((count) => count + 1);

  return (
    <Screen bar="hero">
      <ScrollView
        ref={scroll}
        contentContainerClassName="gap-8 pb-24"
        keyboardShouldPersistTaps="handled"
      >
        <HeroSample />
        <Section title="Button">
          <Button label="Primary md" onPress={bump} />
          <Button label="Primary lg" size="lg" onPress={bump} />
          <Button label="Secondary" variant="secondary" onPress={bump} />
          <Button label="Ghost" variant="ghost" onPress={bump} />
          <Button label="Disabled" disabled onPress={bump} />
          <Button label="Loading" loading onPress={bump} />
          <Button label="Secondary loading" variant="secondary" loading onPress={bump} />
          <Text className="text-footnote text-gray-500">Presses: {presses}</Text>
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
            <Text className="text-body text-navy-900">Static card</Text>
          </Card>
          <Card onPress={bump} accessibilityLabel="Pressable card">
            <Text className="text-body text-navy-900">Pressable card</Text>
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
          <Skeleton width="60%" height={24} radius="md" />
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

        <Section title="Overlays">
          <Button
            label="Show sheet"
            variant="secondary"
            onPress={() => router.push("/dev/sheet")}
          />
          <Button
            label="Show short sheet"
            variant="secondary"
            onPress={() => router.push("/dev/sheet-fit")}
          />
          <Button
            label="Toast: neutral"
            variant="ghost"
            onPress={() => showToast({ message: "Your note was saved", tone: "neutral" })}
          />
          <Button
            label="Toast: success"
            variant="ghost"
            onPress={() => showToast({ message: "Visit confirmed for Tuesday", tone: "success" })}
          />
          <Button
            label="Toast: danger"
            variant="ghost"
            onPress={() =>
              showToast({ message: "Could not reach the server. Try again.", tone: "danger" })
            }
          />
        </Section>

        <Section title="Glass">
          <GlassSurface tone="light" shape="xl" className="gap-1 p-4">
            <Text className="text-headline text-navy-900">Light tone, xl</Text>
            <Text className="text-footnote text-gray-500">
              Native glass on iOS 26; a lifted white surface everywhere else.
            </Text>
          </GlassSurface>
          <GlassSurface tone="dark" shape="lg" className="gap-1 p-4">
            <Text className="text-headline text-white">Dark tone, lg</Text>
            <Text className="text-footnote text-white">Solid navy-700 when glass is off.</Text>
          </GlassSurface>
          <GlassSurface tone="light" shape="pill" interactive className="self-start px-5 py-3">
            <Text className="text-headline text-navy-900">Interactive pill</Text>
          </GlassSurface>
        </Section>
      </ScrollView>
      <FloatingBar scrollRef={scroll} />
    </Screen>
  );
}

export default function ComponentsGalleryScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Gallery />;
}
