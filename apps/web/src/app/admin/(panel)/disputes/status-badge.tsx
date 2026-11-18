import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

import type { DisputeStatus } from "./disputes";

// Open asks for attention (the warning fill, navy text on top), resolved is quiet.
const VARIANT: Record<DisputeStatus, NonNullable<BadgeProps["variant"]>> = {
  open: "warning",
  resolved: "muted",
};

export function StatusBadge({ status, children }: { status: DisputeStatus; children: ReactNode }) {
  return <Badge variant={VARIANT[status]}>{children}</Badge>;
}

/**
 * The list's chip for a dispute whose refund Stripe failed or canceled: the money did not go
 * back, and staff repair it. The panel's red, with its words.
 */
export function RefundFailedChip({ children }: { children: ReactNode }) {
  return (
    <Badge data-refund="failed" className="bg-danger text-white">
      {children}
    </Badge>
  );
}
