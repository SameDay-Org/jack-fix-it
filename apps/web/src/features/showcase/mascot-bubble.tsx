import type { MascotPose } from "@jack/mascot";
import { Mascot } from "@jack/mascot/react";

import { MascotImage } from "@/features/site/mascot-image";
import { cn } from "@/lib/utils";

/**
 * Jack in a round white bubble, standing on its lower edge: decoration beside a section, so
 * it is hidden from assistive tech. `className` gives the bubble its size and its place. A
 * still image unless `animate` (an inline SVG with the idle loops, which run only when motion is
 * allowed and it is on screen): the page animates at most two mascots.
 */
export function MascotBubble({
  pose,
  className,
  animate = false,
}: {
  pose: MascotPose;
  className?: string;
  animate?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-end justify-center overflow-hidden rounded-full bg-white shadow-xl shadow-navy-900/20",
        className,
      )}
    >
      {animate ? (
        <Mascot pose={pose} className="h-[86%] w-[86%]" />
      ) : (
        <MascotImage pose={pose} className="h-[86%] w-[86%]" />
      )}
    </span>
  );
}
