import type { TFunction } from "i18next";

import { Badge } from "@/components/ui/badge";

import type { MetricCard } from "./kpis";

/**
 * The figures as a grid of cards: one column on a phone, more as the panel widens. Each card
 * says what it counts, its value (or "No data yet" when the API has none, never a made-up 0)
 * and, behind a native disclosure, the formula from docs/kpis.md.
 */
export function MetricCards({ cards, t }: { cards: MetricCard[]; t: TFunction }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((card) => {
        const titleId = `kpi-${card.key}`;
        return (
          <li key={card.key}>
            <article
              aria-labelledby={titleId}
              className="flex h-full flex-col gap-3 rounded-lg bg-white p-5 text-navy-900 shadow-[0_8px_24px_rgb(1_23_46/0.08)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 id={titleId} className="font-bold">
                  {card.title}
                </h3>
                {card.beforeRefunds ? (
                  <Badge variant="warning">{t("admin.kpis.beforeRefunds")}</Badge>
                ) : null}
              </div>
              <p className="text-sm text-gray-500">{card.description}</p>
              {card.figure === null ? (
                <p className="text-lg font-semibold text-gray-500">{t("admin.kpis.noData")}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <p className="text-3xl font-bold tabular-nums">{card.figure.value}</p>
                  {card.figure.details.map((line) => (
                    <p key={line} className="text-sm text-gray-500 tabular-nums">
                      {line}
                    </p>
                  ))}
                </div>
              )}
              {card.beforeRefunds ? (
                <p className="text-sm text-gray-500">{t("admin.kpis.beforeRefundsHelp")}</p>
              ) : null}
              <details className="mt-auto text-sm">
                <summary className="cursor-pointer rounded-sm font-semibold text-green-700 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2">
                  {t("admin.kpis.howCalculated")}
                </summary>
                <p className="pt-2 text-gray-500">{t(`admin.kpis.formula.${card.formula}`)}</p>
              </details>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
