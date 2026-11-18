"use client";

import { type KeyboardEvent, useRef } from "react";

import { FOCUS_ON_NAVY } from "./ui";

export type MenuLink = { href: string; label: string };

// This file runs in the browser, so it stays small on purpose: class names are joined by
// hand (`cn` would ship tailwind-merge to every visitor) and the two icons are drawn here.
const ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  "aria-hidden": true,
} as const;

/**
 * The header's section links on a small screen: a native disclosure (`<details>`), so it
 * opens and closes with a tap, Enter or Space before any script runs. The script only tidies
 * up: choosing a section or pressing Escape closes the list (Escape hands the focus back to
 * the button).
 */
export function MobileMenu({
  label,
  navLabel,
  links,
}: {
  /** The button's name. */
  label: string;
  /** The name of the list of links, as a navigation landmark. */
  navLabel: string;
  links: MenuLink[];
}) {
  const details = useRef<HTMLDetailsElement>(null);

  function close(): void {
    details.current?.removeAttribute("open");
  }

  function onKeyDown(event: KeyboardEvent<HTMLDetailsElement>): void {
    if (event.key !== "Escape" || !details.current?.open) return;
    close();
    details.current.querySelector("summary")?.focus();
  }

  return (
    <details ref={details} onKeyDown={onKeyDown} className="group relative lg:hidden">
      <summary
        aria-label={label}
        className={`grid size-11 cursor-pointer list-none place-items-center rounded-full text-white hover:bg-navy-700 [&::-webkit-details-marker]:hidden ${FOCUS_ON_NAVY}`}
      >
        <svg {...ICON} className="size-6 group-open:hidden">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <svg {...ICON} className="hidden size-6 group-open:block">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </summary>
      <nav
        aria-label={navLabel}
        className="absolute top-full right-0 mt-3 w-64 max-w-[calc(100vw-2.5rem)] rounded-lg bg-navy-700 p-2 shadow-2xl shadow-navy-900/40"
      >
        <ul className="flex flex-col gap-1">
          {links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                onClick={close}
                className={`flex min-h-12 items-center rounded-md px-4 text-base font-semibold text-white hover:bg-navy-900 ${FOCUS_ON_NAVY}`}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
