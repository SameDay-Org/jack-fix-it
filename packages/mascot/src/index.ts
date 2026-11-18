/**
 * Jack, the Jack Fix It mascot (#404): framework-neutral data (named parts of flat filled
 * shapes, poses as compositions of them) and an SVG string renderer. The React component for
 * the web is in `@jack/mascot/react`; the app maps the same tree to react-native-svg.
 */
export { BRAND, MASCOT_TONES, PALETTE, type Tone } from "./palette.ts";
export {
  group,
  partsOf,
  VIEW_BOX,
  type Group,
  type MascotNode,
  type Shape,
  type Side,
} from "./shapes.ts";
export { renderSvg, shapeAttributes, type SvgOptions } from "./render.ts";
export {
  isReadyPose,
  MASCOT_POSES,
  poseNode,
  READY_POSES,
  type MascotPose,
  type ReadyPose,
} from "./poses.ts";
export { EXPRESSIONS, expression, type Expression } from "./parts/face.ts";
export { clipboard, toolbox, wrench } from "./parts/props.ts";
export { arm, type ArmPose, type Glove } from "./parts/arms.ts";
export { cheeks, ears, face, hair, nose } from "./parts/head.ts";
export { hat } from "./parts/hat.ts";
export { belt, legs, neck, patch, shirt } from "./parts/body.ts";
