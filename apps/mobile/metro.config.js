const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// rem 16 (NativeWind's default is 14) makes Tailwind's spacing scale the 4-pt grid: p-1 = 4 dp.
module.exports = withNativeWind(config, { input: "./src/global.css", inlineRem: 16 });
