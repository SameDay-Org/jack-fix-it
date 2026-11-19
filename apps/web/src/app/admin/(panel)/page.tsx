import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

import { QUEUE_PATH } from "./queue/queue";

/**
 * The panel's home. An agent's work is the operations queue, so an agent lands there after
 * signing in (#81); an admin gets the home, with the way to the queue.
 */
export default async function PanelHome() {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  if (user.role === "agent") redirect(QUEUE_PATH);
  const t = await getT(toLocale(user.locale));
  // Staff accounts are created with a first name; the email only stands in when it is missing.
  const name = user.first_name?.trim() || user.email;

  return (
    <Card className="flex max-w-2xl flex-col items-start gap-4">
      <h1 className="text-xl font-bold break-words">{t("admin.home.welcome", { name })}</h1>
      <Link
        href={QUEUE_PATH}
        className="inline-flex h-11 items-center rounded-pill bg-green-500 px-6 text-sm font-semibold text-navy-900 outline-none hover:bg-green-700 hover:text-white focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        {t("admin.home.openQueue")}
      </Link>
    </Card>
  );
}
