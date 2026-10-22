import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui Badge as a pill tag. Text colors follow the AA rules in docs/design/README.md.
const badgeVariants = cva("inline-flex items-center rounded-pill px-3 py-1 text-xs font-semibold", {
  variants: {
    variant: {
      onNavy: "bg-navy-700 text-white",
      warning: "bg-warning text-navy-900",
    },
  },
  defaultVariants: { variant: "onNavy" },
});

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
