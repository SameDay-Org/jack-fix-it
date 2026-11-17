import { getImageProps } from "next/image";

import { cn } from "@/lib/utils";

import type { ShowcaseMedia } from "./media";

type PhoneFrameProps = {
  media: ShowcaseMedia;
  /** What the screen shows, in the page's language. */
  alt: string;
  /** How wide the phone is drawn at each breakpoint: the `sizes` of its screen image. */
  sizes: string;
  /** Fetch the screen first, with the page: for the phone in the first viewport only. */
  eager?: boolean;
  /** Sets the phone's width; its height follows the screen's own proportions. */
  className?: string;
};

const BUTTON = "absolute w-[1.3cqw] bg-gray-500";

/**
 * A phone drawn in CSS around one screen of the app: a metal band, a dark bezel, the camera
 * island and the side buttons. Every measure is a share of the phone's width (container
 * units), so the frame keeps its proportions at any size, and the screen keeps the
 * proportions of its image: nothing moves when the image arrives.
 *
 * The screen is a plain `<img>` with the attributes `next/image` computes on the server
 * (`getImageProps`: the optimized `srcset`, the reserved size, lazy loading), so the page
 * gets the optimized images without the image component's client code.
 */
export function PhoneFrame({ media, alt, sizes, eager = false, className }: PhoneFrameProps) {
  const { props: screen } = getImageProps({
    src: media.poster.src,
    width: media.poster.width,
    height: media.poster.height,
    alt,
    sizes,
    loading: eager ? "eager" : "lazy",
    fetchPriority: eager ? "high" : undefined,
  });

  return (
    <div className={cn("@container", className)}>
      <div className="relative rounded-[15cqw] bg-linear-to-b from-gray-500 to-navy-900 p-[1.1cqw] shadow-2xl shadow-navy-900/30">
        <span
          aria-hidden
          className={cn(BUTTON, "top-[15%] -left-[1cqw] h-[3.5%] rounded-l-full")}
        />
        <span
          aria-hidden
          className={cn(BUTTON, "top-[22%] -left-[1cqw] h-[6.5%] rounded-l-full")}
        />
        <span
          aria-hidden
          className={cn(BUTTON, "top-[30%] -left-[1cqw] h-[6.5%] rounded-l-full")}
        />
        <span
          aria-hidden
          className={cn(BUTTON, "top-[25%] -right-[1cqw] h-[10%] rounded-r-full")}
        />
        <div className="rounded-[14cqw] bg-navy-900 p-[2.6cqw]">
          <div className="relative overflow-hidden rounded-[11.5cqw] bg-navy-700">
            {/* eslint-disable-next-line @next/next/no-img-element -- these are next/image's own
                attributes (getImageProps): its optimized srcset without its client component */}
            <img {...screen} alt={alt} className="block h-auto w-full" />
            {/* The camera island, then a faint reflection across the glass. */}
            <span
              aria-hidden
              className="absolute top-[2.4cqw] left-1/2 h-[8cqw] w-[30cqw] -translate-x-1/2 rounded-pill bg-navy-900"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-linear-to-br from-white/10 via-transparent to-transparent"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
