// When to draw everybody else, by the server's clock.
//
// Other players are drawn a little in the past, between the two snapshots
// either side of that moment, which needs to know when each snapshot was
// taken. When it arrived is not that: a snapshot held up on the way and the
// next one on time arrive together, and drawing by arrival moves everybody
// else in starts and stops however steadily they ran. The server stamps every
// snapshot with its own clock (`server_time_ms`, from its tick), which does
// not wobble, so other players are drawn by that - and this works out which
// moment of it to draw.
//
// The page's clock and the server's differ by an offset: the two clocks'
// difference plus however long a snapshot takes to arrive. It is taken from
// the snapshots that arrived soonest in the last two seconds - the least
// delayed are the truest - so a late snapshot is just late, and still lands
// where it belongs inside the interpolation delay, while a route that has
// really got slower is followed within two seconds. Small changes are eased
// in, so the picture never jumps; a big one - a server that stalled, or
// restarted - is taken at once.
//
// No DOM: `client/lag.mjs` runs this same file in Node to measure it.

/** How far back the soonest arrival is looked for. */
const WINDOW_MS = 2000;

/** How fast a small change in the offset is eased in, as a share of the
 *  time that passes: the picture runs up to this much fast or slow. */
const SLEW = 0.05;

/** A change bigger than this is a stall or a restart, not a route getting
 *  quicker or slower, and is taken at once. */
const SNAP_MS = 150;

export class SnapshotClock {
  /** @param {number} delayMs how far behind the newest snapshot to draw. */
  constructor(delayMs) {
    this.delayMs = delayMs;
    /** [page time it arrived, page time minus server time], oldest first. */
    this.samples = [];
    /** The offset being drawn with, eased towards the soonest arrival. */
    this.offset = null;
    this.lastServerMs = null;
  }

  /**
   * Notes a snapshot stamped `serverMs` by the server arriving at `nowMs`.
   * Returns true when the server's clock went backwards - it restarted - in
   * which case anything timed by the old one should go.
   */
  note(serverMs, nowMs) {
    if (!Number.isFinite(serverMs)) return false;
    let restarted = false;
    if (this.lastServerMs !== null && serverMs < this.lastServerMs) {
      this.samples.length = 0;
      this.offset = null;
      restarted = true;
    }
    this.lastServerMs = serverMs;
    this.samples.push([nowMs, nowMs - serverMs]);
    while (this.samples.length > 1 && nowMs - this.samples[0][0] > WINDOW_MS) {
      this.samples.shift();
    }
    if (this.offset === null) this.offset = this.target();
    return restarted;
  }

  /** The offset the soonest recent arrival says. */
  target() {
    let best = Infinity;
    for (const [, sample] of this.samples) if (sample < best) best = sample;
    return best;
  }

  /**
   * The server time to draw everybody else at this frame, or null before
   * any snapshot has arrived. `dtMs` is the time since the last frame, over
   * which a small change of offset is eased in.
   */
  drawAt(nowMs, dtMs) {
    if (this.offset === null) return null;
    const target = this.target();
    const gap = target - this.offset;
    if (Math.abs(gap) > SNAP_MS) {
      this.offset = target;
    } else {
      const step = Math.max(0, dtMs) * SLEW;
      this.offset += Math.max(-step, Math.min(step, gap));
    }
    return nowMs - this.offset - this.delayMs;
  }
}
