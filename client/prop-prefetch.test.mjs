import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { propPhotoSets, PROP_SETS } from './src/props.js';

async function nodeNames(map) {
  const bytes = await readFile(new URL(`../assets/maps/${map}.glb`, import.meta.url));
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  return json.nodes.map((node) => node.name ?? '');
}

test('prefetch follows the procedural stand-in matcher and skips the authored terminal kit', async () => {
  assert.deepEqual(propPhotoSets(await nodeNames('yard')), []);
  assert.deepEqual(propPhotoSets(await nodeNames('arena')), [], 'current Arena uses authored geometry rather than procedural stand-ins');
  assert.deepEqual(propPhotoSets(['Cube036', 'Cylinder1']), [], 'legacy yard-only names cannot match Arena geometry');
  assert.deepEqual(propPhotoSets(['CAR1', 'Cube036']), PROP_SETS);
  assert.deepEqual(propPhotoSets(['crate1']), PROP_SETS, 'new indoor stand-ins still retain their required photos');
  assert.deepEqual(propPhotoSets(['crate.001']), PROP_SETS, 'prefetch matches the names GLTFLoader sanitises');
});
