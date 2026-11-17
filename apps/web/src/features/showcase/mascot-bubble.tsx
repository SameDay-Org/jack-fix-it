import { Mascot, type MascotPose } from "@/features/mascot/mascot";
import { cn } from "@/lib/utils";

/**
 * Jack in a round white bubble, standing on its lower edge: decoration beside a section, so
 * it is hidden from assistive tech. `className` gives the bubble its size and its place.
 */
export function MascotBubble({ pose, className }: { pose: MascotPose; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-end justify-center overflow-hidden rounded-full bg-white shadow-xl shadow-navy-900/20",
        className,
      )}
    >
      <Mascot pose={pose} className="h-[86%] w-[86%]" />
    </span>
  );
}
