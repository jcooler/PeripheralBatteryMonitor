/**
 * Generate PNG icons from SVGs for Stream Deck plugin.
 *
 * Required sizes:
 * - Plugin icon: 72x72 and 144x144 (@2x)
 * - Category icon: 28x28 and 56x56 (@2x)
 * - Action icon: 20x20 and 40x40 (@2x)
 * - Action key image: 72x72 and 144x144 (@2x)
 */
import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PLUGIN_DIR = "com.steelseries.battery.sdPlugin/imgs";

const conversions = [
  // Plugin icons
  {
    svg: `${PLUGIN_DIR}/plugin/icon.svg`,
    outputs: [
      { path: `${PLUGIN_DIR}/plugin/icon.png`, size: 72 },
      { path: `${PLUGIN_DIR}/plugin/icon@2x.png`, size: 144 },
    ],
  },
  // Category icons
  {
    svg: `${PLUGIN_DIR}/plugin/category.svg`,
    outputs: [
      { path: `${PLUGIN_DIR}/plugin/category.png`, size: 28 },
      { path: `${PLUGIN_DIR}/plugin/category@2x.png`, size: 56 },
    ],
  },
  // Action icons (shown in the action list)
  {
    svg: `${PLUGIN_DIR}/actions/battery/icon.svg`,
    outputs: [
      { path: `${PLUGIN_DIR}/actions/battery/icon.png`, size: 20 },
      { path: `${PLUGIN_DIR}/actions/battery/icon@2x.png`, size: 40 },
    ],
  },
  // Action key images (default image on the key)
  {
    svg: `${PLUGIN_DIR}/actions/battery/key.svg`,
    outputs: [
      { path: `${PLUGIN_DIR}/actions/battery/key.png`, size: 72 },
      { path: `${PLUGIN_DIR}/actions/battery/key@2x.png`, size: 144 },
    ],
  },
];

for (const { svg, outputs } of conversions) {
  const svgBuffer = readFileSync(svg);

  for (const { path, size } of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    await sharp(svgBuffer).resize(size, size).png().toFile(path);
    console.log(`  Created ${path} (${size}x${size})`);
  }
}

console.log("Done! All icons generated.");
