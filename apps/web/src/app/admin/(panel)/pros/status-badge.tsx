import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";

import type { ProDocument, ProStatus } from "./pros";

// Pending asks for a decision (the warning fill, navy text on top), approved is settled
// (navy), rejected and superseded are quiet.
const VARIANT: Record<ProStatus | ProDocument["status"], NonNullable<BadgeProps["variant"]>> = {
  pending: "warning",
  approved: "onNavy",
  rejected: "muted",
  superseded: "muted",
};

/** The status of a pro's verification or of one of their documents. */
export function StatusBadge({
  status,
  children,
}: {
  status: ProStatus | ProDocument["status"];
  children: ReactNode;
}) {
  return <Badge variant={VARIANT[status]}>{children}</Badge>;
}
