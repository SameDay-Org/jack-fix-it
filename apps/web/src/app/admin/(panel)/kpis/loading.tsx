import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

const BLOCK = "rounded-lg bg-white shadow-[0_8px_24px_rgb(1_23_46/0.08)] motion-safe:animate-pulse";

/**
 * While the figures load on the way in: the page's frame in gray blocks (the range control,
 * ten cards, the charts), so nothing jumps when they arrive. A change of range keeps the
 * previous figures on screen instead (the control says it is updating).
 */
export default async function KpisLoading() {
  const user = await requireStaff();
  const t = await getT(toLocale(user.locale));
  return (
    <div aria-busy="true" className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-navy-900">{t("admin.kpis.title")}</h1>
        <p role="status" className="text-sm text-gray-500">
          {t("admin.kpis.loading")}
        </p>
      </div>
      <div className={`${BLOCK} h-36`} />
      <ul aria-hidden className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 10 }, (_, index) => (
          <li key={index} className={`${BLOCK} h-44`} />
        ))}
      </ul>
      <div aria-hidden className={`${BLOCK} h-72`} />
    </div>
  );
}
