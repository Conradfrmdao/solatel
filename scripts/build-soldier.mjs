// Builds assets/characters/soldier.glb from Mixamo downloads.
//
//   node scripts/build-soldier.mjs <character.glb> <anims-dir> <out.glb>
//
// The inputs are Mixamo FBX files converted to binary glTF with FBX2glTF
// (see scripts/build-soldier.sh, which runs the whole pipeline). They are
// NOT in the repository: Mixamo's licence allows the character and its
// animations to ship inside the game but not to be redistributed as raw
// files, and this repository is public. Only the output is committed.
//
// What it does:
//
//  * keeps the character's mesh, materials and skeleton;
//  * drops the empty animation the character file carries;
//  * copies one clip from each animation file onto the character's own
//    bones, matched by name - every Mixamo download for one character has
//    the same skeleton - under the name the game looks for;
//  * takes the root motion out of the locomotion clips, so the soldier runs
//    on the spot. The server decides where a player is; a clip that also
//    moved them would have them slide forward and snap back every loop.
//
// It uses gltf-transform, which is not a dependency of the client. Install
// it next to the script's inputs:
//
//   npm install @gltf-transform/core @gltf-transform/extensions

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
import path from 'node:path';

/** Which download becomes which clip, and whether to pin it in place. */
const CLIPS = [
  { file: 'Rifle_Idle.glb', name: 'idle', inPlace: true },
  { file: 'Rifle_Run.glb', name: 'run', inPlace: true },
  { file: 'Firing_Rifle.glb', name: 'fire', inPlace: true },
  // A death keeps its motion: the body is meant to fall over.
  { file: 'Rifle_Death.glb', name: 'death', inPlace: false },
];

const ROOT_BONE = 'mixamorig:Hips';

const [characterPath, animDir, outPath] = process.argv.slice(2);
if (!characterPath || !animDir || !outPath) {
  console.error('usage: node scripts/build-soldier.mjs <character.glb> <anims-dir> <out.glb>');
  process.exit(2);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(characterPath);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];

for (const animation of root.listAnimations()) animation.dispose();
const nodes = new Map(root.listNodes().map((node) => [node.getName(), node]));

for (const clip of CLIPS) {
  const source = await io.read(path.join(animDir, clip.file));
  const animation = source.getRoot().listAnimations()[0];
  if (!animation) throw new Error(`${clip.file} has no animation`);
  const out = doc.createAnimation(clip.name);
  let copied = 0;

  for (const channel of animation.listChannels()) {
    const target = nodes.get(channel.getTargetNode()?.getName());
    if (!target) continue;
    const sampler = channel.getSampler();
    const times = sampler.getInput().getArray().slice();
    const values = sampler.getOutput().getArray().slice();

    // Only the root travels, and only across the ground: height is kept,
    // because the bob of a run is in it. The drift is taken out as a
    // straight line from the first key to the last, which leaves the
    // stride's own sway where it was.
    if (clip.inPlace && target.getName() === ROOT_BONE && channel.getTargetPath() === 'translation') {
      const last = times.length - 1;
      const span = times[last] - times[0] || 1;
      const driftX = values[last * 3] - values[0];
      const driftZ = values[last * 3 + 2] - values[2];
      for (let i = 0; i <= last; i += 1) {
        const t = (times[i] - times[0]) / span;
        values[i * 3] -= driftX * t;
        values[i * 3 + 2] -= driftZ * t;
      }
    }

    const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
    const output = doc
      .createAccessor()
      .setType(sampler.getOutput().getType())
      .setArray(values)
      .setBuffer(buffer);
    const copy = doc
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation(sampler.getInterpolation());
    out.addSampler(copy);
    out.addChannel(
      doc
        .createAnimationChannel()
        .setTargetNode(target)
        .setTargetPath(channel.getTargetPath())
        .setSampler(copy),
    );
    copied += 1;
  }
  console.log(`${clip.name}: ${copied} channels from ${clip.file}`);
}

// What the file is and on what terms, where `scripts/asset-licence.py` reads
// it: a Mixamo download is licensed to whoever downloaded it, for use inside
// their projects, and not for redistribution as a raw asset.
root.getAsset().extras = {
  title: 'Ch15 with rifle idle, run, fire and death clips',
  author: 'Adobe Mixamo',
  license: 'Mixamo terms: royalty-free in games, no attribution; the raw files may not be redistributed',
  source: 'https://www.mixamo.com',
};

await io.write(outPath, doc);
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB)`);
