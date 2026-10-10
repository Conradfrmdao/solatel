// The card a match ends on.
//
// A match used to just stop: the whistle went, or the zone closed on the
// last two, and the next frame was the menu, with a line along the bottom of
// it. Conrad: "nothing is being shown ... they should be shown this has
// happened, this has been won, the total kills, all the statistics from the
// whole match". So whoever was in it gets a card before the lobby - straight
// away at the whistle, and after the death has been played out (death.js)
// for anybody killed - saying how it went, and they close it when they have
// read it.
//
// Every figure on it is the server's (`MatchReport`, sent with `eliminated`
// and `match_ended`): where they finished, how long they lasted, their own
// line of the board, and what came back of the stake - by what the ledger
// was asked to do with it, never by what the client worked the rules out to
// be. The one thing worked out here is the accuracy, from the two counts it
// is the ratio of, which is how the scoreboard shows it too.

/** How long after the card opens a key may close it: the key that skipped
 *  the death sequence, held a moment too long, should not skip this too. */
const KEYS_AFTER_MS = 450;

/** How many of the board are shown: the top, and the player if they are not
 *  among them. */
const BOARD_ROWS = 5;

function money(micros) {
  const cents = Math.round(Math.abs(micros) / 10000);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function clock(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** An element with a class and, optionally, text - always as text: names
 *  are typed by players. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Debrief {
  constructor(root = document.body) {
    this.root = el('div');
    this.root.id = 'debrief';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="db-card" role="dialog" aria-modal="true" aria-labelledby="db-title">
        <div class="db-head">
          <div class="db-title" id="db-title"></div>
          <div class="db-place"></div>
          <div class="db-how"></div>
        </div>
        <div class="db-money">
          <div class="db-cell db-won"><span class="db-label">won from kills</span><b></b><small></small></div>
          <div class="db-cell db-stake"><span class="db-label">your stake</span><b></b><small></small></div>
          <div class="db-cell db-wallet"><span class="db-label">your wallet</span><b></b><small></small></div>
        </div>
        <div class="db-stats"></div>
        <div class="db-board-head"></div>
        <table class="db-board"><tbody></tbody></table>
        <button type="button" class="db-go">Continue</button>
        <div class="db-keys">enter, space or esc</div>
      </div>`;
    root.appendChild(this.root);
    const $ = (selector) => this.root.querySelector(selector);
    this.card = $('.db-card');
    this.title = $('.db-title');
    this.place = $('.db-place');
    this.how = $('.db-how');
    this.won = $('.db-won');
    this.stake = $('.db-stake');
    this.wallet = $('.db-wallet');
    this.stats = $('.db-stats');
    this.boardHead = $('.db-board-head');
    this.board = $('.db-board tbody');
    this.go = $('.db-go');
    this.openedAt = 0;
    this._balance = undefined;

    this.go.addEventListener('click', () => this.hide());
    // Taken before anything else hears it while the card is up: the menu
    // under it is not what these keys are for.
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.open) return;
        if (event.code !== 'Enter' && event.code !== 'Space' && event.code !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || performance.now() - this.openedAt < KEYS_AFTER_MS) return;
        this.hide();
      },
      true,
    );
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  /**
   * Put the card up for `report` (a `MatchReport`). `context` is what the
   * client already had: `you` (this player's id), the `map` and `tier` of
   * the match, how they were `killed` (death.js's summary) if they were,
   * the `board` and whether it is the `final` one, and the `balance` the
   * server last sent, which is null in free play.
   */
  show(report, { you = null, map = null, tier = null, killed = null, board = [], final = false, balance = null } = {}) {
    const stats = report.stats ?? {};
    const alive = Boolean(stats.alive);
    const victory = alive && report.standing <= 1 && report.players > 1;
    const outcome = victory ? 'victory' : alive ? 'survived' : 'eliminated';
    this.card.dataset.outcome = outcome;
    this.title.textContent = { victory: 'Victory', survived: 'Survived', eliminated: 'Eliminated' }[outcome];

    const where = [`#${report.place} of ${report.players}`];
    if (map) where.push(map);
    if (tier) where.push(`$${tier.dollars} table`);
    this.place.textContent = where.join(' · ');
    if (victory) this.how.textContent = 'last one standing';
    else if (alive) this.how.textContent = `the clock ran out · ${report.standing} still standing`;
    else if (killed?.who) this.how.textContent = `by ${killed.who}${killed.how ? ` · ${killed.how}` : ''}`;
    else this.how.textContent = killed?.how ?? '';

    // The money: what the kills paid, what came back of the stake, and the
    // wallet as the server last said.
    const won = stats.winnings_micro_usd ?? 0;
    this.won.querySelector('b').textContent = won > 0 ? `+${money(won)}` : money(0);
    this.won.querySelector('small').textContent = plural(stats.kills ?? 0, 'kill');
    this.won.classList.toggle('db-plus', won > 0);

    const staked = report.stake_micro_usd ?? 0;
    const back = report.stake_back_micro_usd ?? 0;
    this.stake.classList.toggle('hidden', staked <= 0);
    if (staked > 0) {
      const b = this.stake.querySelector('b');
      const small = this.stake.querySelector('small');
      if (back > 0) {
        b.textContent = `${money(back)} back`;
        small.textContent = alive ? 'nobody won it' : `of ${money(staked)}, less the rake`;
      } else {
        b.textContent = money(staked);
        small.textContent = killed?.who ? `went to ${killed.who}` : 'went to whoever killed you';
      }
      this.stake.classList.toggle('db-plus', back > 0);
    }
    this._balance = undefined;
    this.setBalance(balance);

    // What they did.
    const fired = stats.shots_fired ?? 0;
    const hit = stats.shots_hit ?? 0;
    const cells = [
      ['kills', stats.kills ?? 0],
      ['headshots', stats.headshots ?? 0],
      ['accuracy', fired > 0 ? `${Math.round((100 * hit) / fired)}%` : '—'],
      ['damage', stats.damage_dealt ?? 0],
      ['hits', hit],
      ['shots', fired],
      ['time alive', clock(report.alive_ms ?? 0)],
      ['place', `#${report.place}`],
    ];
    this.stats.replaceChildren(
      ...cells.map(([label, value]) => {
        const cell = el('div', 'db-stat');
        cell.append(el('b', '', String(value)), el('span', '', label));
        return cell;
      }),
    );

    // The board: the final one at the whistle; as it stood when they went,
    // otherwise, because the match goes on without them.
    const rows = board.slice(0, BOARD_ROWS);
    const mine = board.findIndex((entry) => entry.id === you);
    if (mine >= BOARD_ROWS) rows.push(board[mine]);
    this.boardHead.textContent = rows.length ? (final ? 'final board' : 'the board when you went') : '';
    this.board.replaceChildren(
      ...rows.map((entry) => {
        const row = el('tr', entry.id === you ? 'you' : '');
        const rank = board.indexOf(entry) + 1;
        row.append(
          el('td', 'rank', `${rank}`),
          el('td', 'name', entry.name ?? ''),
          el('td', '', plural(entry.kills ?? 0, 'kill')),
          el('td', 'won', (entry.winnings_micro_usd ?? 0) > 0 ? `+${money(entry.winnings_micro_usd)}` : ''),
          el('td', 'state', entry.alive ? 'standing' : ''),
        );
        return row;
      }),
    );

    this.root.classList.remove('hidden');
    this.openedAt = performance.now();
    this.go.focus({ preventScroll: true });
  }

  /** The wallet as the server last said: the stake handed back at the
   *  whistle lands a moment after the card goes up, so it follows. */
  setBalance(balance) {
    if (balance === this._balance) return;
    this._balance = balance;
    const known = balance !== null && balance !== undefined;
    this.wallet.classList.toggle('hidden', !known);
    if (known) {
      this.wallet.querySelector('b').textContent = money(balance);
      this.wallet.querySelector('small').textContent = 'yours to play or withdraw';
    }
  }

  hide() {
    this.root.classList.add('hidden');
  }
}
