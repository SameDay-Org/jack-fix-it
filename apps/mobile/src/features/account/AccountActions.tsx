import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

import { logout, type SessionUser } from "@/api";
import { Button } from "@/components/ui";

type AccountActionsProps = {
  user: SessionUser;
  /** Prefix for the buttons' test ids: `<prefix>-verify-phone`, `<prefix>-log-out`. */
  testID: string;
};

/** Verify the phone (until it is verified) and log out, at the foot of an account page. */
export function AccountActions({ user, testID }: AccountActionsProps) {
  const { t } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);

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

  return (
    <View className="gap-3">
      {user.phone_verified ? null : (
        <Button
          label={t("home.verifyPhone")}
          size="lg"
          onPress={() => router.push("/verify-phone")}
          testID={`${testID}-verify-phone`}
        />
      )}
      <Button
        label={t("home.logOut")}
        variant="secondary"
        loading={signingOut}
        onPress={() => void signOut()}
        testID={`${testID}-log-out`}
      />
    </View>
  );
}
