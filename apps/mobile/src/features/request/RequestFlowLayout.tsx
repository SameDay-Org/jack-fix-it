import { router, Stack, useNavigation, usePreventRemove } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";

import { sheetOptions } from "@/components/ui";
import { useMediaUpload, type MediaUpload } from "@/features/media";

import { useSendRequest, type CreatedRequest, type SendRequest } from "./api";
import { hasDraftInput, resetDraft, useRequestDraft } from "./requestDraft";
import { rememberSent } from "./sent";

type RequestFlow = {
  /** The request's photos and videos: one list for the whole flow, so Back never loses them. */
  media: MediaUpload;
  /**
   * Leaves the flow (Back on the first step, Cancel): asks "Discard request?" first when the
   * customer would lose something.
   */
  close: () => void;
  /** The request went through: the flow gives way to its confirmation. */
  finish: (request: CreatedRequest) => void;
  /**
   * The flow's one send: held here, not by Review, so no second Review (after an Edit) can send
   * again while the first is in flight.
   */
  send: SendRequest;
  /** A send is in flight: Back, Cancel and Edit wait for its answer, and leaving is blocked. */
  sending: boolean;
};

const RequestFlowContext = createContext<RequestFlow | null>(null);

export function useRequestFlowContext(): RequestFlow {
  const flow = useContext(RequestFlowContext);
  if (!flow) throw new Error("useRequestFlowContext needs RequestFlowLayout ((flow) layout)");
  return flow;
}

type Ending = { kind: "left" } | { kind: "sent"; id: string };

/**
 * The request flow (D8.2, #45): its steps in one stack pushed over the tabs. The layout lives as
 * long as the flow, so it holds what the steps share: the upload list, the leave guard and the
 * hand-off to the confirmation. Leaving with anything entered asks first, however it is left
 * (Back on the first step, Cancel, Android's back, the iOS edge swipe). The draft goes with the
 * flow: sent, discarded, or taken away by a sign-out.
 */
export function RequestFlowLayout() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const media = useMediaUpload({ purpose: "request_media" });
  const draftInput = useRequestDraft(hasDraftInput);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const { send, sending: sendBusy } = useSendRequest();
  const sending = sendBusy && ending === null;
  const guarded = (draftInput || media.items.length > 0) && ending === null && !discarding;

  const confirmDiscard = useCallback(
    (discard: () => void) =>
      Alert.alert(t("request.discard.title"), t("request.discard.body"), [
        { text: t("request.discard.keep"), style: "cancel" },
        { text: t("request.discard.confirm"), style: "destructive", onPress: discard },
      ]),
    [t],
  );

  // expo-router blocks every removal while the guard is on, a replayed one too: a confirmed
  // discard turns it off and replays the blocked back with `repeat`.
  // While a send is in flight nothing leaves: the request may already exist on the server.
  usePreventRemove(guarded || sending, ({ repeat }) => {
    if (sending) return;
    confirmDiscard(() => {
      setDiscarding(true);
      repeat();
    });
  });

  // Runs after the commit that turned the guard off, so the navigation is not blocked.
  useEffect(() => {
    if (ending?.kind === "left") navigation.goBack();
    if (ending?.kind === "sent")
      router.replace({ pathname: "/request/sent", params: { id: ending.id } });
  }, [ending, navigation]);

  useEffect(() => () => resetDraft(), []);

  const flow = useMemo<RequestFlow>(
    () => ({
      media,
      close: () => {
        if (sending) return;
        const leave = () => setEnding({ kind: "left" });
        if (guarded) confirmDiscard(leave);
        else leave();
      },
      finish: (request) => {
        rememberSent(request);
        setEnding({ kind: "sent", id: request.id });
      },
      send,
      sending,
    }),
    [media, guarded, confirmDiscard, send, sending],
  );

  return (
    <RequestFlowContext.Provider value={flow}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="media-source" options={sheetOptions("fitToContents")} />
      </Stack>
    </RequestFlowContext.Provider>
  );
}
