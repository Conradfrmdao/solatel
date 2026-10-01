// Fetching a map before it is needed.
//
// A map is tens of megabytes now - its photographs above all - and the
// warm-up is fifteen seconds. So its files are fetched the moment a player
// picks its table, while they wait in line, into the browser's own cache:
// every file is named after its contents and kept for good (`served.rs`),
// so when the match starts the loaders find each one there and nothing is
// downloaded twice. A player whose line forms at once still gets the same
// download, counted in bytes on the loading card instead of in the queue.
//
// Which files a map needs is read from the map itself: the material names
// and scene extras in its glTF's JSON say which photographs its surfaces
// wear and whether it grows trees and grass, which is everything the loaders
// will ask for besides its sky.

import { asset } from './assets.js';
import { photoFiles } from './photo.js';
import { lightFiles } from './light.js';
import { scatterFiles } from './scatter.js';
import { natureFiles } from './nature.js';
import { PROP_SETS } from './props.js';
import { skyFiles } from './world.js';

const running = new Map();

/** Starts fetching `mapName`'s files, once; returns what is under way. */
export function prefetchMap(mapName) {
  if (!mapName) return null;
  if (!running.has(mapName)) running.set(mapName, new Prefetch(mapName));
  return running.get(mapName);
}

class Prefetch {
  constructor(mapName) {
    /** URL -> bytes expected (0 until known) and bytes in. */
    this.files = new Map();
    this.done = false;
    this.ready = this._run(mapName).then(
      () => {
        this.done = true;
      },
      (err) => {
        // The loaders fetch for themselves anyway; this was only a head start.
        console.warn(`could not fetch ${mapName} ahead of time:`, err);
        this.done = true;
      },
    );
  }

  /** Bytes in and bytes expected, over every file started so far. */
  progress() {
    let loaded = 0;
    let total = 0;
    for (const { expected, got } of this.files.values()) {
      loaded += expected ? Math.min(got, expected) : got;
      total += Math.max(expected, got);
    }
    return { loaded, total, done: this.done };
  }

  async _run(mapName) {
    const map = await this._get(asset(`assets/maps/${mapName}.glb`), true);
    const { materials, extras } = readGlb(map);
    const urls = [
      ...skyFiles(mapName),
      ...lightFiles(mapName),
      ...scatterFiles(mapName),
      ...photoFiles(materials),
      ...PROP_SETS.flatMap((set) => photoFiles([], [set])),
      ...photoFiles([], ['concrete_wall', 'brick']),
      ...natureFiles(extras),
    ];
    await Promise.all([...new Set(urls)].map((url) => this._get(url, false)));
  }

  /** Fetches into the cache, counting as it goes; returns the bytes if kept. */
  async _get(url, keep) {
    const entry = { expected: 0, got: 0 };
    this.files.set(url, entry);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    // A compressed response's length is of the compressed bytes, and the
    // body arrives decompressed, so its size is only known once it is in.
    if (!response.headers.get('content-encoding')) {
      entry.expected = Number(response.headers.get('content-length') ?? 0);
    }
    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      entry.got += value.length;
      if (keep) chunks.push(value);
    }
    entry.expected = entry.got;
    if (!keep) return null;
    const bytes = new Uint8Array(entry.got);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  }
}

/** The material names and the first scene's extras, out of a GLB's JSON. */
function readGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  return {
    materials: (json.materials ?? []).map((m) => m.name ?? ''),
    extras: json.scenes?.[json.scene ?? 0]?.extras ?? {},
  };
}
