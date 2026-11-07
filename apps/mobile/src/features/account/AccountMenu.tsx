import { router } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, View } from "react-native";

import { logout } from "@/api";
import { ACCOUNT_GLYPHS } from "@/components/icons";
import { ListGroup, ListRow } from "@/components/ui";

/**
 * The Account tab's short list: Settings, Help and Legal open their screens; Log out sits apart, has
 * no chevron (it opens nothing) and asks first.
 */
export function AccountMenu() {
  const { t } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);
  // One question at a time: a second quick tap would stack a second dialog on Android.
  const asking = useRef(false);

  // The gate leaves this screen as soon as the sign-out begins; a failed local delete is shown on
  // welcome through `cleanupPending`.
  const signOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // Surfaced on welcome.
    } finally {
      setSigningOut(false);
    }
  };

  const confirmSignOut = () => {
    if (asking.current) return;
    asking.current = true;
    const answered = () => {
      asking.current = false;
    };
    Alert.alert(
      t("account.logOut.title"),
      t("account.logOut.body"),
      [
        { text: t("account.logOut.cancel"), style: "cancel", onPress: answered },
        {
          text: t("account.logOut.confirm"),
          style: "destructive",
          onPress: () => {
            answered();
            void signOut();
          },
        },
      ],
      // Back or a tap outside closes it on Android, the same as Cancel.
      { cancelable: true, onDismiss: answered },
    );
  };

  return (
    <View className="gap-4">
      <ListGroup testID="account-menu">
        <ListRow
          label={t("account.menu.settings")}
          glyph={ACCOUNT_GLYPHS.settings}
          onPress={() => router.push("/settings")}
          testID="account-settings"
        />
        <ListRow
          label={t("account.menu.help")}
          glyph={ACCOUNT_GLYPHS.help}
          onPress={() => router.push("/help")}
          testID="account-help"
        />
        <ListRow
          label={t("account.menu.legal")}
          glyph={ACCOUNT_GLYPHS.legal}
          onPress={() => router.push("/legal")}
          testID="account-legal"
        />
      </ListGroup>
      <ListGroup>
        <ListRow
          label={t("account.menu.logOut")}
          glyph={ACCOUNT_GLYPHS.logOut}
          chevron={false}
          busy={signingOut}
          accessibilityHint={t("account.logOut.hint")}
          onPress={confirmSignOut}
          testID="account-log-out"
        />
      </ListGroup>
    </View>
  );
}
