// Dev-only short sheet sized to its content, unreachable outside __DEV__: literal strings on purpose.
import { Redirect, router } from "expo-router";
import { Text } from "react-native";

import { Button, SheetContent } from "@/components/ui";

export default function SheetFitScreen() {
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SheetContent
      fitToContents
      title="Leave without saving?"
      actions={
        <>
          <Button label="Keep editing" variant="ghost" onPress={() => router.back()} />
          <Button label="Leave" onPress={() => router.back()} />
        </>
      }
    >
      <Text className="text-body text-navy-900">Your note will be lost.</Text>
    </SheetContent>
  );
}
