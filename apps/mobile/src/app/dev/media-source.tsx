// Dev-only: the gallery's "Camera or library" sheet. Unreachable outside __DEV__.
import { Redirect } from "expo-router";

import { MediaSourceSheet } from "@/features/media";

export default function MediaSourceSheetScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <MediaSourceSheet />;
}
