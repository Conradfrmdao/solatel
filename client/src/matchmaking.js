// The screens between picking a table and playing on it.
//
// What every matchmaker does, in the order they all do it: a searching
// screen that says what is being searched for, how long it has been, how
// full the table is and how to back out; a "match found" moment with a
// sound, because the player may be in another window by then; and a
// loading screen that says what is loading, so the black frame while a map
// arrives is not a mystery. The warm-up countdown that follows is drawn over
// the game itself, by the HUD.
//
// Everything here is displayed, not decided. The lines, the seats, the
// clock on a line that will start short of full and the price are all the
// server's; the only number this invents is how long the player has been
// looking at the searching screen.

/** A found match stays on screen at least this long, so it is seen: with
 *  the database next door the entry fees land in milliseconds and the
 *  splash would otherwise be one frame. It costs nothing - the match is in
 *  its warm-up while this is up. */
const FOUND_MIN_MS = 1600;

export class Matchmaking {
  constructor(root, { onLeave }) {
    this.root = root;
    root.innerHTML = TEMPLATE;
    this.card = root.querySelector('.mm-card');
    this.title = root.querySelector('.mm-title');
    this.clock = root.querySelector('.mm-clock');
    this.table = root.querySelector('.mm-table');
    this.fill = root.querySelector('.mm-bar .fill');
    this.seats = root.querySelector('.mm-seats');
    this.status = root.querySelector('.mm-status');
    this.fine = root.querySelector('.mm-fine');
    this.download = root.querySelector('.mm-download');
    this.leave = root.querySelector('.mm-leave');
    this.leave.addEventListener('click', () => onLeave());
    this._phase = null;
    this._foundAt = null;
    this._foundFor = null;
  }

  /**
   * Draw this frame's state.
   *
   * `phase` is 'searching', 'found', 'loading' or null for none of them;
   * the rest is what that phase shows. Returns whether the overlay is up.
   */
  update(view) {
    let phase = view.phase;
    // Hold a fresh "match found" on screen for a moment even if the match
    // has already started loading behind it.
    const now = performance.now();
    if (view.foundKey && view.foundKey !== this._foundFor) {
      this._foundFor = view.foundKey;
      this._foundAt = now;
    }
    const fresh = this._foundAt !== null && now - this._foundAt < FOUND_MIN_MS;
    if (fresh && (phase === 'loading' || (phase === null && view.inMatch))) phase = 'found';
    if (phase === null && !fresh) this._foundAt = null;

    if (phase !== this._phase) {
      this._phase = phase;
      this.root.classList.toggle('hidden', phase === null);
      this.card.dataset.phase = phase ?? '';
      this.leave.classList.toggle('hidden', phase !== 'searching');
    }
    if (phase === null) return false;

    const place = view.map ? `<b>${escapeHtml(view.map)}</b>` : '';
    const stake = view.dollars ? ` &middot; $${view.dollars} table` : '';
    const fetching = Boolean(view.download && !view.download.done);
    this.card.dataset.fetching = fetching ? 'yes' : 'no';
    this._set(this.download, phase === 'loading' ? '' : downloadLine(view.download));

    if (phase === 'searching') {
      this._set(this.title, 'finding a match');
      this._set(this.clock, clock(view.elapsedMs));
      this._set(this.table, `${place}${stake}`);
      const seats = Math.max(1, view.seats || 1);
      const waiting = Math.max(view.waiting, view.confirmed ? 0 : 1);
      this.fill.style.transform = `scaleX(${Math.min(1, waiting / seats)})`;
      this._set(this.seats, `${waiting} of ${seats} seats`);
      let status;
      if (!view.confirmed) {
        status = 'joining the line…';
      } else if (view.waiting < view.needed) {
        const short = view.needed - view.waiting;
        // No clock on a line that is short of the floor: it is not counting
        // down to anything, and a clock would say it was.
        status = `waiting for ${short} more player${short === 1 ? '' : 's'} to start`;
      } else if (view.formingInMs > 0) {
        status = `starts in ${clock(view.formingInMs)}, or as soon as the table fills`;
      } else {
        status = 'starting…';
      }
      if (view.confirmed && view.place > 0) status += ` &middot; you are #${view.place} in line`;
      this._set(this.status, status);
      this._set(
        this.fine,
        view.entry
          ? `entry ${view.entry}${view.reward ? ` &middot; ${view.reward} a kill` : ''} &middot; ` +
              'charged only when the match starts'
          : 'charged only when the match starts',
      );
    } else if (phase === 'found') {
      this._set(this.title, 'match found');
      this._set(this.clock, '');
      this._set(this.table, `${place}${stake}${view.players ? ` &middot; ${plural(view.players, 'player')}` : ''}`);
      this.fill.style.transform = 'scaleX(1)';
      this._set(this.seats, '');
      this._set(this.status, view.entry ? `taking your ${view.entry} entry…` : 'getting ready…');
      this._set(this.fine, 'the match starts with a short countdown on your spawn');
    } else {
      this._set(this.title, 'match found');
      this._set(this.clock, '');
      this._set(this.table, `${place}${stake}${view.players ? ` &middot; ${plural(view.players, 'player')}` : ''}`);
      this.fill.style.transform = 'scaleX(1)';
      this._set(this.seats, '');
      if (fetching) {
        // The download is most of the wait on a first visit: say so, in bytes.
        const { loaded, total } = view.download;
        this.fill.style.transform = `scaleX(${total > 0 ? Math.min(1, loaded / total) : 0})`;
        this._set(this.status, `downloading ${escapeHtml(view.map ?? 'the map')} &middot; ${megabytes(loaded, total)}`);
      } else if (view.preparing) {
        // Compiling the map's shaders, behind this card rather than as a
        // black first frame: see `prepareToDraw` in main.js.
        this._set(this.status, `preparing ${escapeHtml(view.map ?? 'the map')}…`);
      } else {
        this._set(this.status, `loading ${escapeHtml(view.map ?? 'the map')}…`);
      }
      this._set(this.fine, 'the match starts with a short countdown on your spawn');
    }
    return true;
  }

  /** Only touch the DOM when the text changed; this runs every frame. */
  _set(element, html) {
    if (element._html !== html) {
      element._html = html;
      element.innerHTML = html;
    }
  }
}

/** "12.3 of 41.0 MB". */
function megabytes(loaded, total) {
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  return `${mb(loaded)} of ${mb(total)} MB`;
}

/** The map's download, while waiting: under way, or done. */
function downloadLine(download) {
  if (!download || download.total === 0) return '';
  if (download.done) return 'map downloaded';
  return `downloading the map &middot; ${megabytes(download.loaded, download.total)}`;
}

/** Milliseconds as m:ss. */
function clock(ms) {
  const seconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

const TEMPLATE = `
  <div class="mm-card" data-phase="">
    <div class="mm-radar"><span></span><span></span><span></span><i></i></div>
    <div class="mm-head">
      <div class="mm-title"></div>
      <div class="mm-clock"></div>
    </div>
    <div class="mm-table"></div>
    <div class="mm-bar"><span class="fill"></span></div>
    <div class="mm-seats"></div>
    <div class="mm-status"></div>
    <div class="mm-fine"></div>
    <div class="mm-download"></div>
    <button class="mm-leave" type="button">leave the line</button>
  </div>
`;

/** "1 player", "12 players". */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
