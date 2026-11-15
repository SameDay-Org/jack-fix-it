// A binary glTF model, bundled by Metro as an asset: the import is the asset's id.
declare module "*.glb" {
  const asset: number;
  export default asset;
}
