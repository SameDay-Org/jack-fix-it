import { Models, type ModelLayerStyle } from "@rnmapbox/maps";
import { memo, useMemo } from "react";
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
const REAL_SIZE_ZOOM = 19;
const FAR_ZOOM = 8;
const FAR_SCALE = 2 ** (REAL_SIZE_ZOOM - FAR_ZOOM);
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
 * The van reads its turn from the feature the frames write, as the arrow does, so no frame goes
 * through React. Its opacity cannot come from the feature (the map's model layer takes one
 * opacity for the layer): `vanModelStyle` gives the layer's style, dimmed while the position is old.
 */
const VAN_MODEL_STYLE: ModelLayerStyle = {
  modelId: VAN_MODEL,
  modelType: "common-3d",
  modelRotation: ["get", "rotation"],
  // Said in full: a key that is only left out keeps the value the layer had last.
  modelOpacity: 1,
  modelScale: [
    "interpolate",
    ["exponential", 0.5],
    ["zoom"],
    FAR_ZOOM,
    ["literal", [FAR_SCALE, FAR_SCALE, FAR_SCALE]],
    REAL_SIZE_ZOOM,
    ["literal", [1, 1, 1]],
  ],
  modelCastShadows: true,
};
const STALE_VAN_MODEL_STYLE: ModelLayerStyle = { ...VAN_MODEL_STYLE, modelOpacity: STALE_OPACITY };

/** The van layer's style: two fixed objects, so the layer is restyled only when `stale` flips. */
export const vanModelStyle = (stale: boolean): ModelLayerStyle =>
  stale ? STALE_VAN_MODEL_STYLE : VAN_MODEL_STYLE;

/**
 * Where the map can read the van's model from, or null when the model is not in the app (the
 * caller draws the arrow instead). A build carries it as a bundled asset, which the map library
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
