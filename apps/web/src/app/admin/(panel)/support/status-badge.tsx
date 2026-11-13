import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

import type { TicketStatus } from "./tickets";

// Open asks for attention (the warning fill, navy text on top), in progress is taken (navy),
// closed is quiet.
const VARIANT: Record<TicketStatus, NonNullable<BadgeProps["variant"]>> = {
  open: "warning",
  in_progress: "onNavy",
  closed: "muted",
};

export function StatusBadge({ status, children }: { status: TicketStatus; children: ReactNode }) {
  return <Badge variant={VARIANT[status]}>{children}</Badge>;
}
