import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

const BLOCK = "rounded-md bg-gray-50 motion-safe:animate-pulse";

/** The list's frame while the API answers: its title, then gray rows (still under Reduce Motion). */
export default async function DisputesLoading() {
  const user = await requireStaff();
  const t = await getT(toLocale(user.locale));
  return (
    <div className="flex max-w-6xl flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.disputes.title")}</h1>
        <p role="status" className="text-sm text-gray-500">
          {t("admin.disputes.loading")}
        </p>
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        <div className={`${BLOCK} h-9 w-48`} />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={`${BLOCK} h-16 w-full`} />
        ))}
      </div>
    </div>
  );
}
