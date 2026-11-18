import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

import type { DisputeStatus, RefundState } from "./disputes";

// Open asks for attention (the warning fill, navy text on top), resolved is quiet.
const VARIANT: Record<DisputeStatus, NonNullable<BadgeProps["variant"]>> = {
  open: "warning",
  resolved: "muted",
};

export function StatusBadge({ status, children }: { status: DisputeStatus; children: ReactNode }) {
  return <Badge variant={VARIANT[status]}>{children}</Badge>;
}

// A failed refund is the panel's red; a pending one waits, on the navy fill.
const REFUND_TONE: Record<NonNullable<RefundState>, string> = {
  failed: "bg-danger text-white",
  pending: "",
};

/** The refund chip of a dispute whose refund failed or is still being processed. */
export function RefundChip({ state, children }: { state: RefundState; children: ReactNode }) {
  if (!state) return null;
  return (
    <Badge data-refund={state} className={REFUND_TONE[state] || undefined}>
      {children}
    </Badge>
  );
}
