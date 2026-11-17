import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The poses a page may ask for. The final mascot (handoffs/mascot.md) keeps these names. */
export const MASCOT_POSES = ["wave", "point", "celebrate", "peek", "thinking", "tools"] as const;

export type MascotPose = (typeof MASCOT_POSES)[number];

export type MascotProps = {
  pose: MascotPose;
  /** Width and height in CSS pixels: every pose is drawn in the same square. */
  size?: number;
  /** The accessible name. Without one the mascot is decoration, hidden from assistive tech. */
  title?: string;
  className?: string;
};

// PLACEHOLDER ARTWORK: a friendly worker silhouette in the brand colors, drawn by hand in a
// 200 x 200 box, until the mascot task delivers the real character. Only what is drawn
// changes then: the props of <Mascot> stay as they are.

const SHOULDER = { left: "M64 142", right: "M136 142" } as const;

function Arm({ d }: { d: string }) {
  return (
    <path
      d={d}
      fill="none"
      strokeWidth="15"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="stroke-navy-700"
    />
  );
}

/** A work glove at the end of an arm. */
function Hand({ x, y, r = 9.5 }: { x: number; y: number; r?: number }) {
  return <circle cx={x} cy={y} r={r} className="fill-green-500" />;
}

function Torso() {
  return (
    <>
      <path d="M56 200v-46a44 44 0 0 1 88 0v46z" className="fill-navy-700" />
      {/* Tool belt and its buckle. */}
      <rect x="56" y="184" width="88" height="9" className="fill-navy-900" />
      <rect x="94" y="182.5" width="12" height="12" rx="3" className="fill-green-500" />
      {/* The "J" patch on the shirt. */}
      <rect x="112" y="146" width="18" height="18" rx="5" className="fill-green-500" />
      <path
        d="M123.2 150.5v6.4a3.2 3.2 0 0 1-6.4 0"
        fill="none"
        strokeWidth="2.6"
        strokeLinecap="round"
        className="stroke-navy-900"
      />
    </>
  );
}

/** The head with its hard hat; `dy` moves it down, `pondering` flattens the smile. */
function Head({ dy = 0, pondering = false }: { dy?: number; pondering?: boolean }) {
  return (
    <g transform={dy ? `translate(0 ${dy})` : undefined}>
      <circle cx="100" cy="86" r="30" className="fill-navy-900" />
      <rect x="94" y="33" width="12" height="11" rx="4" className="fill-green-700" />
      <path d="M66 72a34 34 0 0 1 68 0z" className="fill-green-500" />
      <rect x="58" y="68" width="84" height="10" rx="5" className="fill-green-700" />
      <circle cx="89" cy="90" r="3.4" className="fill-white" />
      <circle cx="111" cy="90" r="3.4" className="fill-white" />
      <path
        d={pondering ? "M93 102h12" : "M89 100q11 9 22 0"}
        fill="none"
        strokeWidth="3.2"
        strokeLinecap="round"
        className="stroke-white"
      />
    </g>
  );
}

function HandOnHip() {
  return (
    <>
      <Arm d={`${SHOULDER.left}L46 160L60 176`} />
      <Hand x={63} y={178} />
    </>
  );
}

function Sparkle({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <path
      d="M0-8L2.2-2.2L8 0L2.2 2.2L0 8L-2.2 2.2L-8 0L-2.2-2.2Z"
      transform={`translate(${x} ${y}) scale(${scale})`}
      className="fill-green-500"
    />
  );
}

const POSES: Record<MascotPose, () => ReactNode> = {
  wave: () => (
    <>
      <Torso />
      <Arm d={`${SHOULDER.left}L52 176`} />
      <Hand x={50} y={182} />
      <Head />
      <Arm d={`${SHOULDER.right}L158 118L164 88`} />
      <Hand x={165} y={80} />
      <path
        d="M181 64q7 10 1 20M191 56q11 15 2 32"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-green-500"
      />
    </>
  ),
  point: () => (
    <>
      <Torso />
      <HandOnHip />
      <Head />
      <Arm d={`${SHOULDER.right}L170 136`} />
      <path
        d="M182 134.5L194 133"
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        className="stroke-green-500"
      />
      <Hand x={178} y={135} />
    </>
  ),
  celebrate: () => (
    <>
      <Torso />
      <Arm d={`${SHOULDER.left}L40 112L38 84`} />
      <Hand x={37} y={76} />
      <Head />
      <Arm d={`${SHOULDER.right}L160 112L162 84`} />
      <Hand x={163} y={76} />
      <Sparkle x={20} y={42} />
      <Sparkle x={180} y={42} />
      <Sparkle x={100} y={16} scale={0.8} />
    </>
  ),
  // Head and hands only, cut by the bottom edge: set it on top of whatever it peeks over.
  peek: () => (
    <>
      <Head dy={92} />
      <Hand x={50} y={199} r={11.5} />
      <Hand x={150} y={199} r={11.5} />
    </>
  ),
  thinking: () => (
    <>
      <Torso />
      <HandOnHip />
      <Head pondering />
      <Arm d={`${SHOULDER.right}L150 168L126 128`} />
      <Hand x={123} y={120} />
      <circle cx="158" cy="66" r="3.5" className="fill-green-500" />
      <circle cx="169" cy="52" r="5.5" className="fill-green-500" />
      <circle cx="184" cy="34" r="9" className="fill-green-500" />
    </>
  ),
  tools: () => (
    <>
      <Torso />
      <HandOnHip />
      <Head />
      <Arm d={`${SHOULDER.right}L160 124L162 96`} />
      {/* An open-end wrench, held up. */}
      <g transform="translate(163 88) rotate(18)" className="fill-gray-500 stroke-gray-500">
        <rect x="-4.5" y="-46" width="9" height="56" rx="4.5" stroke="none" />
        <path d="M-7-64A11 11 0 1 0 7-64" fill="none" strokeWidth="7" strokeLinecap="round" />
      </g>
      <Hand x={163} y={88} />
    </>
  ),
};

/**
 * Jack, the brand's mascot, in one of his poses. Decoration unless it gets a `title`.
 */
export function Mascot({ pose, size = 120, title, className }: MascotProps) {
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      data-pose={pose}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cn("shrink-0", className)}
    >
      {POSES[pose]()}
    </svg>
  );
}
