// Dev-only gallery content for the ID card (#291), unreachable outside __DEV__: the sample people
// and places below are literal on purpose. Both variants, a field that types into one of them, and
// the off-screen share render with the pixel size of what it captures.
import { useEffect, useRef, useState } from "react";
import { Image, Text, useWindowDimensions, View } from "react-native";

import { apiConfig } from "@/api/config";
import {
  Button,
  ID_CARD_ASPECT,
  IdCard,
  IdCardShareRender,
  Input,
  Notice,
  type IdCardShareCapture,
  type IdCardShareHandle,
} from "@/components/ui";

/** The gallery's horizontal gutter (px-4). */
const GUTTER = 16;

// A 48x64 PNG gradient with a soft oval, so the photo frame shows a loaded image without a network.
export const SAMPLE_PHOTO =
  "data:image/png;base64,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";

const PRO = {
  name: "Alex Morgan",
  city: "Fort Lauderdale",
  state: "FL",
  phone: "(954) 555-0142",
  publicCode: "K7Q29MXA",
};
const CUSTOMER = { city: "Miami", state: "FL", phone: "(305) 555-0199", publicCode: "9MXAK7Q2" };

type Capture =
  | { status: "idle" }
  | { status: "capturing" }
  | ({ status: "captured" } & IdCardShareCapture)
  | { status: "failed"; message: string };

export function IdCardSample() {
  const { width } = useWindowDimensions();
  const cardWidth = width - 2 * GUTTER;
  const [name, setName] = useState("María Pérez");
  const share = useRef<IdCardShareHandle>(null);
  const [capture, setCapture] = useState<Capture>({ status: "idle" });
  // The preview's PNG lives until the next capture replaces it or the gallery closes.
  const shown = useRef<IdCardShareCapture | null>(null);
  const release = () => {
    shown.current?.discard();
    shown.current = null;
  };
  useEffect(() => () => shown.current?.discard(), []);

  const captureShare = async () => {
    const target = share.current;
    if (!target) return;
    setCapture({ status: "capturing" });
    release();
    try {
      const next = await target.capture();
      // Two quick taps: the capture this one replaces may have landed meanwhile.
      release();
      shown.current = next;
      setCapture({ status: "captured", ...next });
    } catch (error) {
      setCapture({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <View className="gap-4">
      <IdCard
        variant="pro"
        width={cardWidth}
        name={PRO.name}
        city={PRO.city}
        state={PRO.state}
        phone={PRO.phone}
        photoUri={SAMPLE_PHOTO}
        publicCode={PRO.publicCode}
        testID="id-card-pro"
      />
      <IdCard
        variant="customer"
        width={cardWidth}
        name={name}
        city={CUSTOMER.city}
        state={CUSTOMER.state}
        phone={CUSTOMER.phone}
        publicCode={CUSTOMER.publicCode}
        testID="id-card-customer"
      />
      <Input
        label="Name on the card"
        value={name}
        onChangeText={setName}
        hint="Types into the white card in place"
        autoCapitalize="words"
      />
      <Text className="text-footnote text-gray-500">
        Drag to lean it, tap or swipe to turn it over; move the phone and it follows.
      </Text>
      <Button
        label="Capture the share PNG"
        variant="secondary"
        loading={capture.status === "capturing"}
        onPress={() => void captureShare()}
      />
      {capture.status === "captured" ? (
        <View className="gap-2">
          <Image
            source={{ uri: capture.uri }}
            className="w-full rounded-lg"
            style={{ aspectRatio: ID_CARD_ASPECT }}
            accessibilityLabel="The captured share image"
            testID="id-card-share-preview"
          />
          <Text className="text-footnote text-gray-500" testID="id-card-share-size">
            {`${capture.width} x ${capture.height} px`}
          </Text>
        </View>
      ) : null}
      {capture.status === "failed" ? (
        <Notice tone="danger" title="Capture failed" body={capture.message} />
      ) : null}
      <IdCardShareRender
        ref={share}
        variant="customer"
        name={name}
        city={CUSTOMER.city}
        state={CUSTOMER.state}
        photoUri={SAMPLE_PHOTO}
        publicCode={CUSTOMER.publicCode}
        photoTimeoutMs={apiConfig.timeoutMs}
        testID="id-card-share-render"
      />
    </View>
  );
}
