import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { toLocale } from "@/i18n/locale";
import { getT } from "@/i18n/server";
import { requireStaff } from "@/lib/session";

/** The words it shows: each record's own "back" and "doesn't exist" lines. */
type Keys =
  | { back: "admin.pros.detail.back"; message: "admin.pros.detail.notFound" }
  | { back: "admin.requests.back"; message: "admin.requests.notFound" }
  | { back: "admin.support.detail.back"; message: "admin.support.detail.notFound" };

/**
 * A panel record that does not exist (#494): the way back to its list, and the page's heading
 * saying so. Rendered by the record's `not-found.tsx`, so the answer is a real 404, inside the
 * panel layout, in the staff member's language.
 */
export async function MissingRecord({ href, keys }: { href: string; keys: Keys }) {
  // Cached per request: the layout already asked the API who this is.
  const user = await requireStaff();
  const t = await getT(toLocale(user.locale));
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link
        href={href}
        className="inline-flex items-center gap-2 self-start rounded-pill text-sm font-semibold text-navy-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t(keys.back)}
      </Link>
      <Card>
        <h1 className="text-xl font-bold">{t(keys.message)}</h1>
      </Card>
    </div>
  );
}
