// Dev-only gallery sample, unreachable outside __DEV__: the sample strings below are literal on purpose.
import { Text } from "react-native";

import { useSession } from "@/api";
import { Card } from "@/components/ui";
import { MediaPicker, useMediaUpload } from "@/features/media";

/**
 * Request media against the configured API and its storage: pick, compress, upload, with each
 * item's progress, retry and removal. Needs a signed-in customer (the purpose's role); the
 * storage setup for a local run is in apps/mobile/AGENTS.md.
 */
export function MediaUploadSample() {
  const { status, user } = useSession();
  const upload = useMediaUpload({ purpose: "request_media" });

  if (status !== "signedIn" || user?.role !== "customer") {
    return (
      <Card>
        <Text className="text-callout text-gray-500">
          Sign in as a customer to try uploads: request media is theirs.
        </Text>
      </Card>
    );
  }
  return <MediaPicker upload={upload} sourceSheet="/dev/media-source" testID="media-sample" />;
}
