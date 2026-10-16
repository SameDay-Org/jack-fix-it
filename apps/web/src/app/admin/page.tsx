import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";

// Placeholder until the admin/BDC panel (D16.1, #80).
export default async function AdminPage() {
  const t = await getT(defaultLocale);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold">{t("admin.title")}</h1>
      <p className="text-navy/70">{t("admin.notAvailable")}</p>
    </main>
  );
}
