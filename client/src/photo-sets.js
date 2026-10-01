// Written by scripts/fetch-photo-assets.mjs; do not edit.
//
// Each photo set's average colour (sRGB, 0 to 255), which `photo.js` tints
// from; its average roughness, which the palette's gloss is varied around;
// and the size its colour was fetched at.
export const PHOTO_SETS = {
  concrete_wall: { average: [138, 131, 109], roughness: 0.729, size: 2048 },
  concrete_floor: { average: [83, 84, 81], roughness: 0.529, size: 2048 },
  asphalt: { average: [87, 87, 82], roughness: 0.761, size: 2048 },
  grass: { average: [148, 129, 87], roughness: 0.675, size: 1024 },
  dry_grass: { average: [129, 119, 103], roughness: 0.820, size: 1024 },
  dirt: { average: [96, 80, 60], roughness: 0.933, size: 1024 },
  gravel: { average: [159, 131, 98], roughness: 0.498, size: 1024 },
  shore: { average: [72, 66, 43], roughness: 0.835, size: 1024 },
  cliff: { average: [121, 80, 47], roughness: 0.851, size: 1024 },
  corrugated: { average: [86, 85, 78], roughness: 0.510, size: 2048 },
  container: { average: [109, 153, 96], roughness: 0.659, size: 2048 },
  rusty_metal: { average: [169, 141, 87], roughness: 0.416, size: 1024 },
  painted_metal: { average: [106, 57, 41], roughness: 0.812, size: 1024 },
  metal_plate: { average: [82, 70, 59], roughness: 0.647, size: 1024 },
  plaster: { average: [184, 174, 161], roughness: 0.902, size: 2048 },
  brick: { average: [159, 140, 115], roughness: 0.776, size: 2048 },
  planks: { average: [105, 97, 87], roughness: 0.506, size: 1024 },
  roof_tiles: { average: [143, 77, 40], roughness: 0.906, size: 1024 },
  bark: { average: [100, 80, 62], roughness: 0.698, size: 1024 },
};
