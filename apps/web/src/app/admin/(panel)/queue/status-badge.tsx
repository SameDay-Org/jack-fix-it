import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

import type { RequestStatus } from "./queue";

// A request still waiting on the BDC asks for attention (the warning fill, navy text on top),
// one moving through pros and quotes is under way (navy), a finished one is quiet.
const VARIANT: Record<RequestStatus, NonNullable<BadgeProps["variant"]>> = {
  received: "warning",
  reviewing: "warning",
  finding_pro: "onNavy",
  quote_ready: "onNavy",
  accepted: "onNavy",
  expired: "muted",
  cancelled: "muted",
};

export function StatusBadge({ status, children }: { status: RequestStatus; children: ReactNode }) {
  return <Badge variant={VARIANT[status]}>{children}</Badge>;
}
