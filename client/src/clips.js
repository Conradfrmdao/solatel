// Clip it: the last seconds of play, saved with one key.
//
// A kill worth a dollar is a kill worth showing somebody, and the moment to
// decide that is after it happened. So, when the setting is on, the frames
// the game draws are encoded as it draws them (WebCodecs, a keyframe every
// second), the last `CLIP_SECONDS` of encoded video are kept in memory, and
// F8 writes them out as a WebM file - no recording started in advance, no
// screen-capture prompt, nothing uploaded anywhere.
//
// It is the same idea as a console's "save the last thirty seconds": an
// encoder that is always running and a buffer that forgets from the front,
// cut at a keyframe so the file starts with a picture. The container is
// written here rather than by a library, because a WebM with one video track
// is a few dozen bytes of headers around the encoded frames.
//
// The clip is the 3D view only: the HUD is the page's, not the canvas's. It
// is silent, for now. And it is off by default, because encoding video costs
// the frame rate something on a machine that has none to spare.

const CLIP_SECONDS = 20;
/** Frames a second encoded, whatever the game draws at. */
const CLIP_FPS = 30;
/** The largest a clip is encoded at; bigger windows are scaled down. */
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const BITRATE = 5_000_000;
const SETTING_KEY = 'solatel.clips';

/** VP9 where the browser has it, VP8 where it does not. */
const CODECS = [
  { codec: 'vp09.00.10.08', webm: 'V_VP9' },
  { codec: 'vp8', webm: 'V_VP8' },
];

export function clipsSupported() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

export function clipsWanted() {
  try {
    return window.localStorage.getItem(SETTING_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setClipsWanted(on) {
  try {
    window.localStorage.setItem(SETTING_KEY, on ? 'on' : 'off');
  } catch {
    /* private browsing: on for this session only */
  }
}

export class Clips {
  constructor() {
    this.enabled = false;
    this.encoder = null;
    this.codec = null;
    this.size = null;
    this.chunks = [];
    this.frames = 0;
    this.lastAt = -Infinity;
    this.keyAt = -Infinity;
    this.canvas = null;
    this.g = null;
    this.failed = null;
    this.saving = false;
  }

  /** Turn recording on or off. Off lets go of the encoder and the buffer. */
  async setEnabled(on) {
    this.enabled = Boolean(on) && clipsSupported();
    if (!this.enabled) this._close();
  }

  get seconds() {
    if (this.chunks.length < 2) return 0;
    return (this.chunks.at(-1).timestamp - this.chunks[0].timestamp) / 1e6;
  }

  /**
   * One drawn frame. Called straight after the frame is rendered, while the
   * canvas still holds it.
   */
  capture(source, now) {
    if (!this.enabled || this.failed || this.saving) return;
    if (now - this.lastAt < 1000 / CLIP_FPS - 2) return;
    const scale = Math.min(1, MAX_WIDTH / source.width, MAX_HEIGHT / source.height);
    // Even sizes: the encoders subsample colour by two in each direction.
    const w = Math.max(2, Math.round((source.width * scale) / 2) * 2);
    const h = Math.max(2, Math.round((source.height * scale) / 2) * 2);
    if (!this.encoder || this.size?.w !== w || this.size?.h !== h) {
      if (!this._open(w, h)) return;
    }
    // A slow machine falls behind the encoder: drop frames rather than
    // queueing seconds of them.
    if (this.encoder.state !== 'configured' || this.encoder.encodeQueueSize > 2) return;
    this.lastAt = now;
    this.g.drawImage(source, 0, 0, w, h);
    // The mark, small, in the corner: where this came from.
    this.g.font = `600 ${Math.round(h / 40)}px ui-monospace, monospace`;
    this.g.fillStyle = 'rgba(255, 255, 255, 0.55)';
    this.g.fillText('SOLATEL', Math.round(w * 0.02), Math.round(h * 0.96));
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(now * 1000) });
    try {
      // A keyframe a second, by the clock rather than by count, so the clip
      // is cut to its length on a machine drawing ten frames a second as on
      // one drawing a hundred.
      const key = this.frames === 0 || now - this.keyAt >= 1000;
      if (key) this.keyAt = now;
      this.encoder.encode(frame, { keyFrame: key });
      this.frames += 1;
    } finally {
      frame.close();
    }
  }

  /** Write the buffer out as a file. Answers how many seconds it held. */
  async save() {
    if (!this.encoder || this.saving) return 0;
    this.saving = true;
    try {
      await this.encoder.flush();
      // Starting on a keyframe, or the file opens on a grey smear.
      const first = this.chunks.findIndex((c) => c.type === 'key');
      if (first < 0) return 0;
      const chunks = this.chunks.slice(first);
      const bytes = muxWebm(chunks, this.codec.webm, this.size.w, this.size.h);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `solatel-clip-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.lastSaved = { bytes, seconds: (chunks.at(-1).timestamp - chunks[0].timestamp) / 1e6 };
      return this.lastSaved.seconds;
    } finally {
      // After a flush the next frame must be a keyframe.
      this.frames = 0;
      this.saving = false;
    }
  }

  _open(w, h) {
    this._close();
    for (const choice of CODECS) {
      try {
        const encoder = new VideoEncoder({
          output: (chunk) => this._keep(chunk),
          error: (err) => {
            this.failed = String(err?.message ?? err);
            this._close();
          },
        });
        encoder.configure({
          codec: choice.codec,
          width: w,
          height: h,
          bitrate: BITRATE,
          framerate: CLIP_FPS,
          latencyMode: 'realtime',
        });
        this.encoder = encoder;
        this.codec = choice;
        break;
      } catch {
        /* that codec is not here: try the next */
      }
    }
    if (!this.encoder) {
      this.failed = 'no video encoder in this browser';
      return false;
    }
    this.size = { w, h };
    this.canvas = new OffscreenCanvas(w, h);
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.frames = 0;
    this.chunks = [];
    return true;
  }

  _keep(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
    // Forget from the front, a second at a time: keep the latest keyframe
    // that still leaves the whole clip's length behind it.
    const newest = chunk.timestamp;
    let cut = 0;
    for (let i = 0; i < this.chunks.length; i += 1) {
      const c = this.chunks[i];
      if (newest - c.timestamp < CLIP_SECONDS * 1e6) break;
      if (c.type === 'key') cut = i;
    }
    if (cut > 0) this.chunks.splice(0, cut);
  }

  /** A word on screen that the clip was saved, or why it was not. */
  toast(message) {
    if (!this._toastEl) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;right:18px;bottom:96px;z-index:50;padding:8px 14px;border-radius:8px;' +
        'background:rgba(10,14,18,0.82);color:#e8eef2;font:600 13px ui-monospace,monospace;' +
        'letter-spacing:0.06em;pointer-events:none;transition:opacity 0.4s;opacity:0';
      document.body.appendChild(el);
      this._toastEl = el;
    }
    this._toastEl.textContent = message;
    this._toastEl.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toastEl.style.opacity = '0';
    }, 2600);
  }

  _close() {
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* already gone */
    }
    this.encoder = null;
    this.chunks = [];
    this.size = null;
  }
}

// ---- WebM -----------------------------------------------------------------
//
// EBML: each element is its ID, its size as a variable-length integer, and
// its body. Sizes here are always written in eight bytes, which every reader
// accepts and which keeps the writer to one rule.

function vint8(n) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

function concat(parts) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function element(id, body) {
  const data = body instanceof Uint8Array ? body : concat(body);
  return concat([idBytes(id), vint8(data.length), data]);
}

function uint(id, value) {
  const bytes = [];
  let v = BigInt(value);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  return element(id, Uint8Array.from(bytes));
}

function float64(id, value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return element(id, b);
}

function text(id, value) {
  return element(id, new TextEncoder().encode(value));
}

/** One video track's encoded chunks as a WebM file, a cluster per keyframe. */
export function muxWebm(chunks, codecId, width, height) {
  const t0 = chunks[0].timestamp;
  const ms = (ts) => Math.round((ts - t0) / 1000);
  const duration = ms(chunks.at(-1).timestamp) + Math.round(1000 / CLIP_FPS);

  const header = element(0x1a45dfa3, [
    uint(0x4286, 1),
    uint(0x42f7, 1),
    uint(0x42f2, 4),
    uint(0x42f3, 8),
    text(0x4282, 'webm'),
    uint(0x4287, 2),
    uint(0x4285, 2),
  ]);
  const info = element(0x1549a966, [
    uint(0x2ad7b1, 1_000_000),
    text(0x4d80, 'solatel'),
    text(0x5741, 'solatel'),
    float64(0x4489, duration),
  ]);
  const tracks = element(0x1654ae6b, [
    element(0xae, [
      uint(0xd7, 1),
      uint(0x73c5, 1),
      uint(0x83, 1),
      text(0x86, codecId),
      element(0xe0, [uint(0xb0, width), uint(0xba, height)]),
    ]),
  ]);

  const clusters = [];
  let current = null;
  const close = () => {
    if (current) clusters.push(element(0x1f43b675, current.parts));
  };
  for (const chunk of chunks) {
    const at = ms(chunk.timestamp);
    if (chunk.type === 'key' || !current || at - current.start > 30000) {
      close();
      current = { start: at, parts: [uint(0xe7, at)] };
    }
    // SimpleBlock: track 1, timecode relative to the cluster, keyframe flag.
    const head = new Uint8Array(4);
    head[0] = 0x81;
    new DataView(head.buffer).setInt16(1, at - current.start);
    head[3] = chunk.type === 'key' ? 0x80 : 0x00;
    current.parts.push(element(0xa3, concat([head, chunk.data])));
  }
  close();

  const segment = element(0x18538067, [info, tracks, ...clusters]);
  return concat([header, segment]);
}
