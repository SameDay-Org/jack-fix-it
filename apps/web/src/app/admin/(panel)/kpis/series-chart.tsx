"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

/** One line of a chart: its name, its mark color (a panel token) and a value per day. */
export type ChartSeries = { key: string; label: string; color: string; values: number[] };

export type SeriesChartProps = {
  days: string[];
  series: ChartSeries[];
  /** Counts, or money in integer cents. */
  kind: "count" | "money";
  locale: string;
  label: string;
  keyboardHint: string;
  /** A light wash under a single line (never under two: they would cover each other). */
  area?: boolean;
};

// The drawing's own units: the SVG is this size, so its text stays at 12 px. It fills the
// panel's card at 1280 px; a narrower screen scrolls it sideways.
const WIDTH = 880;
const HEIGHT = 220;
const PLOT = { left: 64, right: 56, top: 16, bottom: 32 };
const PLOT_WIDTH = WIDTH - PLOT.left - PLOT.right;
const PLOT_HEIGHT = HEIGHT - PLOT.top - PLOT.bottom;
const TICKS = 4;

/** Round axis steps (1, 2 or 5 times a power of ten), whole numbers for counts. */
export function axisTicks(max: number, kind: SeriesChartProps["kind"]): number[] {
  const unit = kind === "money" ? 100 : 1; // money ticks fall on whole dollars
  const top = Math.max(max, unit);
  const rough = top / TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(
    unit,
    [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? rough,
  );
  const count = Math.ceil(top / step);
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/**
 * Where a scrolling chart scrolls so that a point `pointX` px into the drawing sits in the
 * middle of what shows, never past either end.
 */
export function centeredScroll(pointX: number, clientWidth: number, scrollWidth: number): number {
  const furthest = Math.max(0, scrollWidth - clientWidth);
  return Math.min(furthest, Math.max(0, Math.round(pointX - clientWidth / 2)));
}

function formatter(kind: SeriesChartProps["kind"], locale: string, compact: boolean) {
  if (kind === "count")
    return new Intl.NumberFormat(locale, compact ? { notation: "compact" } : {});
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    ...(compact ? { notation: "compact" } : {}),
  });
}

/**
 * A line chart of per-day figures, drawn as plain SVG: hairline grid, 2 px lines, an end dot
 * per line with its last value. Hover, or focus and the arrow keys, mark a day in the drawing
 * and write every line's value for it in the readout line above the drawing: outside the part
 * that scrolls on a narrow screen, so it is always in view. The arrow keys also scroll the
 * drawing to the day they select. The page's table holds the same numbers for anyone who
 * cannot use the chart.
 */
export function SeriesChart({
  days,
  series,
  kind,
  locale,
  label,
  keyboardHint,
  area = false,
}: SeriesChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const hintId = useId();
  const count = days.length;
  const ticks = axisTicks(Math.max(0, ...series.flatMap((line) => line.values)), kind);
  const top = ticks[ticks.length - 1] ?? 1;
  const x = (index: number) =>
    PLOT.left + (count <= 1 ? PLOT_WIDTH / 2 : (index * PLOT_WIDTH) / (count - 1));
  const y = (value: number) => PLOT.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const tickText = formatter(kind, locale, true);
  const valueText = formatter(kind, locale, false);
  const show = (value: number) => valueText.format(kind === "money" ? value / 100 : value);
  const dayText = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const dayLabel = (index: number) => dayText.format(new Date(`${days[index]}T00:00:00Z`));
  const labelled = [...new Set([0, Math.floor((count - 1) / 2), count - 1])].filter(
    (index) => index >= 0,
  );
  const baseline = y(0);

  // End labels sit beside the last dots; when two would touch, the legend and the readout
  // carry them instead.
  const ends = series.map((line) => y(line.values[count - 1] ?? 0));
  const endLabels = ends.every((end, index) =>
    ends.every((other, otherIndex) => otherIndex === index || Math.abs(end - other) >= 14),
  );

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!box || count === 0) return;
    const unit = ((event.clientX - box.left) * WIDTH) / box.width;
    const index = count <= 1 ? 0 : Math.round(((unit - PLOT.left) * (count - 1)) / PLOT_WIDTH);
    setActive(Math.min(count - 1, Math.max(0, index)));
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = count - 1;
    const current = active ?? last;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "ArrowRight"
          ? Math.min(last, current + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    // On a narrow screen the drawing scrolls sideways: bring the selected day into view (the
    // arrow keys no longer scroll it themselves). At once under Reduce Motion.
    const box = event.currentTarget;
    if (box.scrollWidth > box.clientWidth) {
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      box.scrollTo({
        left: centeredScroll(x(next), box.clientWidth, box.scrollWidth),
        behavior: still ? "auto" : "smooth",
      });
    }
  };

  const readout =
    active === null
      ? ""
      : `${dayLabel(active)}: ${series
          .map((line) => `${line.label} ${show(line.values[active] ?? 0)}`)
          .join(", ")}`;

  return (
    <div className="flex flex-col gap-3">
      {series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500">
          {series.map((line) => (
            <li key={line.key} className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="h-0.5 w-4 rounded-full"
                style={{ background: line.color }}
              />
              {line.label}
            </li>
          ))}
        </ul>
      ) : null}
      {/* The marked day's values, outside the drawing that scrolls: always in view. The live
          region below says the same to a screen reader. Its height is kept when it is empty. */}
      <div
        aria-hidden
        data-readout
        data-index={active ?? undefined}
        className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:min-h-6"
      >
        {active !== null ? (
          <>
            <span className="font-semibold text-navy-900">{dayLabel(active)}</span>
            {series.map((line) => (
              <span key={line.key} className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-0.5 w-3 rounded-full"
                  style={{ background: line.color }}
                />
                <strong className="font-bold text-navy-900 tabular-nums">
                  {show(line.values[active] ?? 0)}
                </strong>
                <span className="text-gray-500">{line.label}</span>
              </span>
            ))}
          </>
        ) : null}
      </div>
      <div
        role="group"
        aria-label={label}
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={move}
        onFocus={() => setActive((current) => current ?? count - 1)}
        onBlur={() => setActive(null)}
        className="relative overflow-x-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2"
      >
        <svg
          aria-hidden
          width={WIDTH}
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block max-w-none"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PLOT.left}
                x2={WIDTH - PLOT.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--color-gray-500)"
                strokeOpacity={0.15}
                strokeWidth={1}
              />
              <text
                x={PLOT.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={12}
                fill="var(--color-gray-500)"
              >
                {tickText.format(kind === "money" ? tick / 100 : tick)}
              </text>
            </g>
          ))}
          <line
            x1={PLOT.left}
            x2={WIDTH - PLOT.right}
            y1={baseline}
            y2={baseline}
            stroke="var(--color-gray-500)"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
          {labelled.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={HEIGHT - 10}
              textAnchor={
                count > 1 && index === 0
                  ? "start"
                  : index === count - 1 && count > 1
                    ? "end"
                    : "middle"
              }
              fontSize={12}
              fill="var(--color-gray-500)"
            >
              {dayLabel(index)}
            </text>
          ))}
          {series.map((line) => {
            const points = line.values.map((value, index) => `${x(index)},${y(value)}`);
            return (
              <g key={line.key}>
                {area && points.length > 1 ? (
                  <path
                    d={`M${x(0)},${baseline} L${points.join(" L")} L${x(count - 1)},${baseline} Z`}
                    fill={line.color}
                    fillOpacity={0.1}
                  />
                ) : null}
                <polyline
                  points={points.join(" ")}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {count > 0 ? (
                  <circle
                    cx={x(count - 1)}
                    cy={y(line.values[count - 1] ?? 0)}
                    r={4}
                    fill={line.color}
                    stroke="var(--color-white)"
                    strokeWidth={2}
                  />
                ) : null}
                {count > 0 && endLabels ? (
                  <text
                    x={x(count - 1) + 10}
                    y={y(line.values[count - 1] ?? 0)}
                    dominantBaseline="middle"
                    fontSize={12}
                    fontWeight={600}
                    fill="var(--color-navy-900)"
                  >
                    {tickText.format(
                      kind === "money"
                        ? (line.values[count - 1] ?? 0) / 100
                        : (line.values[count - 1] ?? 0),
                    )}
                  </text>
                ) : null}
              </g>
            );
          })}
          {active !== null ? (
            <g data-marker>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={PLOT.top}
                y2={baseline}
                stroke="var(--color-gray-500)"
                strokeWidth={1}
              />
              {series.map((line) => (
                <circle
                  key={line.key}
                  cx={x(active)}
                  cy={y(line.values[active] ?? 0)}
                  r={4}
                  fill={line.color}
                  stroke="var(--color-white)"
                  strokeWidth={2}
                />
              ))}
            </g>
          ) : null}
          <rect
            x={PLOT.left}
            y={PLOT.top}
            width={PLOT_WIDTH}
            height={PLOT_HEIGHT}
            fill="transparent"
            onPointerMove={pick}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
      </div>
      <p id={hintId} className="text-xs text-gray-500">
        {keyboardHint}
      </p>
      <p aria-live="polite" className="sr-only">
        {readout}
      </p>
    </div>
  );
}
