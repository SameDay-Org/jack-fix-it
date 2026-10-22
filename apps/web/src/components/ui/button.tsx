import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui Button on the deck tokens (docs/design/README.md): pill shape, navy-900 label on
// green-500 for the primary action (never white on green-500), white on green-700 when pressed.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-pill text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-green-500 text-navy-900 hover:bg-green-700 hover:text-white",
        secondary: "bg-white text-navy-900 shadow-sm hover:bg-gray-50",
        ghostOnNavy: "text-white hover:bg-navy-700",
      },
      size: {
        md: "h-11 px-6",
        sm: "h-9 px-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
