"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A sidebar link that marks itself as the current page: `exact` for the panel home, else the
 * link's own path and everything under it.
 */
export function NavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const current = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-pill px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-navy-700 focus-visible:ring-2 focus-visible:ring-green-500",
        current && "bg-navy-700",
      )}
    >
      {children}
    </Link>
  );
}
