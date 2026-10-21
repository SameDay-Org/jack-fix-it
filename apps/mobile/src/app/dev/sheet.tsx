// Dev-only sample sheet, unreachable outside __DEV__: the sample strings below are literal on purpose.
import { Redirect, router } from "expo-router";
import { useState } from "react";
import { Text } from "react-native";

import { Button, Input, SheetContent } from "@/components/ui";

export default function SheetScreen() {
  const [note, setNote] = useState("");

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SheetContent
      title="Confirm the visit"
      actions={
        <>
          <Button label="Not now" variant="ghost" onPress={() => router.back()} />
          <Button label="Confirm" onPress={() => router.back()} />
        </>
      }
    >
      <Text className="text-body text-navy-900">
        A sample sheet body. Drag the grabber to the second detent, then tap the field to see the
        keyboard handled.
      </Text>
      <Input label="Note for the pro" value={note} onChangeText={setNote} hint="Optional" />
    </SheetContent>
  );
}
