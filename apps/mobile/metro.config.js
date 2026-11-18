const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);
// The live map's 3D van (assets/models/van.glb) ships as an asset.
config.resolver.assetExts.push("glb");

// rem 16 (NativeWind's default is 14) makes Tailwind's spacing scale the 4-pt grid: p-1 = 4 dp.
module.exports = withNativeWind(config, { input: "./src/global.css", inlineRem: 16 });
