import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui Card as a deck "bubble": white, rounded lg, a soft navy-tinted shadow, no border.
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-lg bg-white p-6 text-navy-900 shadow-[0_8px_24px_rgb(1_23_46/0.08)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-xl font-bold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-gray-500", className)} {...props} />;
}
