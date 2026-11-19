import type { MascotPose } from "@jack/mascot";

/** Where a still pose is served (app/mascot/[file]/route.ts). */
export function mascotImagePath(pose: MascotPose): string {
  return `/mascot/${pose}.svg`;
}

/**
 * Jack standing still, as an image of the mascot package's own drawing, loaded lazily: never
 * fetched where it is hidden (the landing's hero on a phone), and right after layout when it is
 * on the first screen. It keeps the page's HTML small: an inline SVG is in the HTML twice (once
 * more in the React payload), which cost the landing a network round trip before its first
 * paint. The mascots that move are `<Mascot>` from `@jack/mascot/react`. Decoration
 * unless it has a title, which becomes its alternative text.
 */
export function MascotImage({
  pose,
  size = 120,
  title,
  className,
}: {
  pose: MascotPose;
  /** Width and height in CSS pixels, as `<Mascot>` takes them. */
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small SVG the site draws itself (the route above): nothing for next/image to resize or convert.
    <img
      src={mascotImagePath(pose)}
      alt={title ?? ""}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      data-pose={pose}
      className={className}
    />
  );
}
