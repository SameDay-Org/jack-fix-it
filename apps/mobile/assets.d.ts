// A binary glTF model, bundled by Metro as an asset: the import is the asset's id.
declare module "*.glb" {
  const asset: number;
  export default asset;
}

// A bitmap (the ID card's grain tile), bundled by Metro as an asset: the import is the asset's id.
declare module "*.png" {
  const asset: number;
  export default asset;
}
