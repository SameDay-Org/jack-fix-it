import { Card, CardDescription } from "@/components/ui/card";
import { defaultLocale } from "@/i18n/config";
import { getT } from "@/i18n/server";
import { RETURN_PARAM, safeReturnPath } from "@/lib/return-path";

import { LoginForm } from "./login-form";

// Before sign-in the account's language is unknown: the panel's default language. The page a
// signed-out staff member asked for (`?next=`) rides along in the form, if it is a panel path.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getT(defaultLocale);
  const requested = (await searchParams)[RETURN_PARAM];
  const returnTo = safeReturnPath(typeof requested === "string" ? requested : null);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-navy-900 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-center text-2xl font-bold text-white">
          {t("brand.name")} <span className="text-green-500">{t("admin.title")}</span>
        </p>
        <Card className="flex flex-col gap-6 rounded-xl p-8">
          <div className="flex flex-col gap-1">
            {/* The page's one h1 (#493); CardTitle would make it an h2. */}
            <h1 className="text-xl font-bold">{t("admin.login.title")}</h1>
            <CardDescription>{t("admin.login.subtitle")}</CardDescription>
          </div>
          <LoginForm
            returnTo={returnTo}
            text={{
              email: t("admin.login.email"),
              password: t("admin.login.password"),
              submit: t("admin.login.submit"),
              submitting: t("admin.login.submitting"),
              errors: {
                invalid_credentials: t("admin.login.errors.invalid_credentials"),
                account_suspended: t("admin.login.errors.account_suspended"),
                rate_limited: t("admin.login.errors.rate_limited"),
                not_staff: t("admin.login.errors.not_staff"),
                unavailable: t("admin.login.errors.unavailable"),
              },
            }}
          />
        </Card>
      </div>
    </main>
  );
}
