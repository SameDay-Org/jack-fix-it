/**
 * Jack, the Jack Fix It mascot (#404): framework-neutral data (named parts of flat filled
 * shapes, poses as rigs of numbers drawn from them) and an SVG string renderer, plus the web's
 * motion rules. The React component is `@jack/mascot/react`, the plain DOM one
 * `@jack/mascot/dom`; the app maps the same tree to react-native-svg.
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
export { ease, interpolateRig, RIGS, rigNode, type PoseRig } from "./rig.ts";
export {
  IDLE_SECONDS,
  idleCss,
  motionScope,
  motionState,
  REDUCED_MOTION_QUERY,
  transition,
  TRANSITION_MS,
  watchMotion,
  type FrameScheduler,
  type MotionEnv,
  type MotionInputs,
  type MotionState,
} from "./motion.ts";
export { EXPRESSIONS, expression, type Expression } from "./parts/face.ts";
export { clipboard, PROPS, question, toolbox, wrench, type PropName } from "./parts/props.ts";
export { arm, elbowOf, type ArmPose, type Glove, type Held } from "./parts/arms.ts";
export { cheeks, ears, face, hair, nose } from "./parts/head.ts";
export { hat } from "./parts/hat.ts";
export { belt, legs, neck, patch, shirt } from "./parts/body.ts";
