import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

export default async function PanelHome() {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const t = await getT(toLocale(user.locale));

  return (
    <Card className="flex max-w-2xl flex-col gap-2">
      <CardTitle className="break-words">
        {t("admin.home.welcome", { email: user.email })}
      </CardTitle>
      <CardDescription>{t("admin.home.queueSoon")}</CardDescription>
    </Card>
  );
}
