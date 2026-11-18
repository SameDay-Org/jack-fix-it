import { isReadyPose, MASCOT_POSES, poseNode, renderSvg } from "@jack/mascot";

// Six files written when the site is built; they change only with the mascot package.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams(): { file: string }[] {
  return MASCOT_POSES.map((pose) => ({ file: `${pose}.svg` }));
}

type Params = { params: Promise<{ file: string }> };

/**
 * Jack standing still in one pose, as a standalone SVG file (`/mascot/<pose>.svg`): the mascot
 * package's own drawing (`renderSvg`), for `MascotImage` (features/site/mascot-image.tsx).
 */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { file } = await params;
  const pose = file.endsWith(".svg") ? file.slice(0, -".svg".length) : "";
  if (!isReadyPose(pose)) return new Response(null, { status: 404 });
  return new Response(renderSvg(poseNode(pose)), {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
  });
}
