import { Models, type ModelLayerStyle } from "@rnmapbox/maps";
import { Component, memo, useMemo, type ReactNode } from "react";
import { Image } from "react-native";

import vanAsset from "../../../../assets/models/van.glb";

import { normalizeDeg } from "./geo";

/** The van's model as the map's style knows it. */
const VAN_MODEL = "jack-van-model";
/**
 * Degrees from the pro's heading (clockwise from north) to the model layer's turn about the
 * vertical axis: the model's nose is glTF's front (+Z), which the map lays toward the south.
 */
const NOSE_TURN_DEG = 180;
/**
 * From this zoom in, the van is its real size (5 m long on the ground). Further out it keeps the
 * size it has on screen there, about as long as the arrow is wide: a real van is a few pixels at
 * the follow camera's zoom.
 */
const REAL_SIZE_ZOOM = 19.5;
/** The van's scale is kept to this many decimals: finer steps cannot be seen. */
const SCALE_DECIMALS = 3;
/** A development server's asset address: the server's asset root, then the file's path. */
const SERVED_ASSET = /^(https?:\/\/[^/]+\/assets\/)\?unstable_path=([^&]+)/;

/** How much of the pro's marker shows while its position is old. */
export const STALE_OPACITY = 0.45;

/** What the map takes for a model: a bundled asset's id, or an address. */
export type VanModelSource = number | string;

/** The model layer's turn (degrees about x, y and the vertical) for a heading. */
export const vanRotation = (bearing: number): [number, number, number] => [
  0,
  0,
  normalizeDeg(bearing + NOSE_TURN_DEG),
];

/**
 * The model layer's scale (x, y, z) at a camera zoom: twice as large for each level out of
 * `REAL_SIZE_ZOOM`, never smaller than the real van. It rides in the pro's feature and not in a
 * zoom expression of the layer's style: the map works such an expression out at whole zoom
 * levels only, which made the van jump to twice its size and back inside each level.
 */
export const vanScale = (zoom: number): [number, number, number] => {
  const scale = Number(Math.max(1, 2 ** (REAL_SIZE_ZOOM - zoom)).toFixed(SCALE_DECIMALS));
  return [scale, scale, scale];
};

/**
 * The van reads its turn and its scale from the feature the map's frames write, as the arrow
 * does, so no frame goes through React. Its opacity cannot come from the feature (the map's model
 * layer takes one opacity for the layer): `vanModelStyle` gives the layer's style, dimmed while
 * the position is old.
 */
const VAN_MODEL_STYLE: ModelLayerStyle = {
  modelId: VAN_MODEL,
  modelType: "common-3d",
  modelRotation: ["get", "rotation"],
  // Said in full: a key that is only left out keeps the value the layer had last.
  modelOpacity: 1,
  modelScale: ["get", "scale"],
  // No shadow: over the arrow it stands on, the van's shadow pass paints a pale square on Android
  // (seen at 320 dp), which costs more than the faint shadow it gives the van on the ground.
  modelCastShadows: false,
};
const STALE_VAN_MODEL_STYLE: ModelLayerStyle = { ...VAN_MODEL_STYLE, modelOpacity: STALE_OPACITY };

/** The van layer's style: two fixed objects, so the layer is restyled only when `stale` flips. */
export const vanModelStyle = (stale: boolean): ModelLayerStyle =>
  stale ? STALE_VAN_MODEL_STYLE : VAN_MODEL_STYLE;

/**
 * Where the map can read the van's model from, or null when the model is not in the app (the map
 * then shows the arrow alone). A build carries it as a bundled asset, which the map library
 * reads by itself. A development server gives an address with the file's path in its query,
 * and the map tells a model's type by the address's extension: that one is turned into the
 * server's plain address of the same file.
 */
export function vanModelSource(): VanModelSource | null {
  const uri = Image.resolveAssetSource(vanAsset)?.uri;
  if (!uri) return null;
  const served = SERVED_ASSET.exec(uri);
  if (served === null) return vanAsset;
  return served[1] + decodeURIComponent(served[2]).replace(/^\.\//, "");
}

/** Hands the van's model to the map's style, once per source. */
export const VanModelAsset = memo(function VanModelAsset({ source }: { source: VanModelSource }) {
  const models = useMemo(() => ({ [VAN_MODEL]: source }), [source]);
  return <Models models={models} />;
});

/**
 * Keeps an error thrown in the van model's part of the map (its registration or its layer) inside
 * that part: it draws nothing from then on and tells the map, which drops the model and keeps the
 * arrow. Its own log line names the error's class only, never its text. React Native still
 * reports every error a boundary catches by itself (to the console and the device log, text and
 * component stack included); this part's props hold no position (the model's address, a fixed
 * style), so neither report carries the pro's.
 */
export class VanModelBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.warn(`Van model failed: ${error instanceof Error ? error.name : "unknown"}`);
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
