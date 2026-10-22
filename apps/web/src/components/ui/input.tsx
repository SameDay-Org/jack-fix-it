import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// shadcn/ui Input on the deck tokens: a pill field with a gray-500 placeholder (AA on white).
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-pill border border-gray-500/30 bg-white px-4 text-base text-navy-900 outline-none placeholder:text-gray-500 focus-visible:border-green-700 focus-visible:ring-2 focus-visible:ring-green-700/30 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-semibold text-navy-900", className)} {...props} />;
}
