import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

const BLOCK = "rounded-md bg-gray-50 motion-safe:animate-pulse";

/** The dispute's frame while the API answers (still under Reduce Motion). */
export default async function DisputeLoading() {
  const user = await requireStaff();
  const t = await getT(toLocale(user.locale));
  return (
    <div className="flex max-w-5xl flex-col gap-6" aria-busy="true">
      <p role="status" className="text-sm text-gray-500">
        {t("admin.disputes.detail.loading")}
      </p>
      <div aria-hidden className="flex flex-col gap-4">
        <div className={`${BLOCK} h-24 w-full`} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={`${BLOCK} h-40`} />
          <div className={`${BLOCK} h-40`} />
        </div>
        <div className={`${BLOCK} h-32 w-full`} />
      </div>
    </div>
  );
}
