import type { Metadata } from "next";
import Link from "next/link";

import { SITE_PAGE } from "@/features/site/font";
import { MascotImage } from "@/features/site/mascot-image";
import { LANDING_PATHS } from "@/features/site/routes";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const [en, es] = await Promise.all([getT("en"), getT("es")]);
  return { title: `${en("site.notFound.metaTitle")} · ${es("site.notFound.metaTitle")}` };
}

const ACTION =
  "inline-flex h-12 items-center justify-center rounded-pill px-7 text-base font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-navy-900";

/**
 * Every address the site does not have, and every `notFound()` (#462): the site's look, calm
 * words and the way home, in English and in Spanish (marked as such). One page for both: the
 * root 404 cannot know the address it answers without reading the request, and reading it
 * here would make every page of the site dynamic. Next answers 404 and adds `noindex`.
 */
export default async function NotFound() {
  const [en, es] = await Promise.all([getT("en"), getT("es")]);

  return (
    <main
      className={`${SITE_PAGE} flex min-h-dvh flex-col items-center justify-center gap-6 bg-navy-900 px-5 py-16 text-center text-white`}
    >
      <MascotImage pose="peek" size={112} className="rounded-full bg-gray-50 p-3" />
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-[clamp(2rem,3vw+1rem,3rem)] leading-tight font-extrabold tracking-tight text-balance">
          {en("site.notFound.title")}
        </h1>
        <p className="text-lg leading-relaxed">{en("site.notFound.body")}</p>
      </div>
      <div lang="es" className="flex max-w-xl flex-col gap-2 text-white/85">
        <p className="text-2xl font-bold text-balance">{es("site.notFound.title")}</p>
        <p className="leading-relaxed">{es("site.notFound.body")}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href={LANDING_PATHS.en}
          prefetch={false}
          className={`${ACTION} bg-green-500 text-navy-900 hover:bg-green-700 hover:text-white`}
        >
          {en("site.notFound.home")}
        </Link>
        <Link
          href={LANDING_PATHS.es}
          prefetch={false}
          lang="es"
          className={`${ACTION} border-2 border-white/40 text-white hover:border-white`}
        >
          {es("site.notFound.home")}
        </Link>
      </div>
    </main>
  );
}
