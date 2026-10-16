import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";

// Placeholder until the landing page (D17.1). No call to action: the request flow does not exist yet.
export default async function LandingPage() {
  const t = await getT(defaultLocale);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-gray-light px-6 text-center">
      <span aria-hidden className="h-1 w-12 rounded-full bg-orange" />
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{t("brand.name")}</h1>
      <p className="max-w-xl text-lg sm:text-xl">{t("brand.tagline")}</p>
      <p className="text-sm text-navy/70">{t("landing.comingSoon")}</p>
    </main>
  );
}
