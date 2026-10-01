// Solana, as much of it as a page needs: base58, a deposit transaction, and
// the Wallet Standard - the way a page finds the wallets a browser has.
//
// No Solana library. The one transaction the page ever builds is a SOL
// transfer with a memo, and the server already lays one out by hand in
// `solana.rs` (`build_transfer`); this lays it out the same way, byte for
// byte, rather than pulling a few hundred kilobytes into the bundle to do it.
// The wallet signs it and sends it: the page never holds a key.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bytes as base58, the way Solana writes keys and signatures. */
export function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}

/** base58 as bytes, or null if it is not base58. */
export function unbase58(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = ALPHABET.indexOf(text[i]);
    if (value < 0) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/**
 * SOL typed by a person, as lamports: read as text, digit by digit, so
 * "0.1" is exactly 100,000,000 and never 99,999,999.99. Null if it is not an
 * amount.
 */
export function parseSol(text) {
  const match = /^\s*(\d{1,9})(?:\.(\d{0,9}))?\s*$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

function shortvec(n, out) {
  let value = n;
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if (value === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

/**
 * A transfer of `lamports` from `payer` to `to` with `memo` attached,
 * unsigned: the signature slot is zeros for the wallet to fill. Every key is
 * base58, `lamports` a BigInt, `blockhash` base58.
 *
 * Laid out as the server's `build_transfer` lays one out, so the one layout
 * is checked on both sides: one signer, the two programs read-only, the
 * transfer at program index 2 and the memo at index 3.
 */
export function depositTransaction({ payer, to, lamports, blockhash, memo }) {
  const keys = [payer, to, SYSTEM_PROGRAM, MEMO_PROGRAM].map(unbase58);
  const hash = unbase58(blockhash);
  if (keys.some((k) => !k || k.length !== 32) || !hash || hash.length !== 32) {
    throw new Error('a key or the blockhash is not 32 bytes of base58');
  }
  const message = [1, 0, 2];
  shortvec(keys.length, message);
  for (const key of keys) message.push(...key);
  message.push(...hash);
  shortvec(2, message);

  // Transfer: instruction 2 of the system program, then the amount.
  message.push(2);
  shortvec(2, message);
  message.push(0, 1);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  shortvec(data.length, message);
  message.push(...data);

  // The memo: who the deposit is for.
  const text = new TextEncoder().encode(memo);
  message.push(3);
  shortvec(0, message);
  shortvec(text.length, message);
  message.push(...text);

  const wire = [];
  shortvec(1, wire);
  wire.push(...new Uint8Array(64));
  wire.push(...message);
  return new Uint8Array(wire);
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** USDC has six decimals: a base unit is one micro-USD. */
export const USDC_DECIMALS = 6;

/**
 * A legacy transaction from instructions, unsigned, with one signer: the fee
 * payer. Accounts are ordered the way the runtime requires - the signer,
 * then writable accounts, then read-only ones, programs among them - and
 * each instruction refers to them by index.
 *
 * `instructions` is `[{ program, keys: [{ key, writable }], data }]`, keys
 * in base58 and data a Uint8Array.
 */
export function compileTransaction(payer, instructions, blockhash) {
  const writable = new Set();
  const all = [payer];
  const add = (key, isWritable) => {
    if (!all.includes(key)) all.push(key);
    if (isWritable) writable.add(key);
  };
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.key, k.writable);
  }
  for (const ix of instructions) add(ix.program, false);
  const rest = all.filter((k) => k !== payer);
  const written = rest.filter((k) => writable.has(k));
  const order = [payer, ...written, ...rest.filter((k) => !writable.has(k))];
  const readOnly = order.length - 1 - written.length;

  const bytes = order.map(unbase58);
  const hash = unbase58(blockhash);
  if (bytes.some((b) => !b || b.length !== 32) || !hash || hash.length !== 32) {
    throw new Error('a key or the blockhash is not 32 bytes of base58');
  }
  const message = [1, 0, readOnly];
  shortvec(order.length, message);
  for (const key of bytes) message.push(...key);
  message.push(...hash);
  shortvec(instructions.length, message);
  for (const ix of instructions) {
    message.push(order.indexOf(ix.program));
    shortvec(ix.keys.length, message);
    for (const k of ix.keys) message.push(order.indexOf(k.key));
    shortvec(ix.data.length, message);
    message.push(...ix.data);
  }
  const wire = [];
  shortvec(1, wire);
  wire.push(...new Uint8Array(64));
  wire.push(...message);
  return new Uint8Array(wire);
}

/**
 * A USDC deposit: the treasury's USDC account made if it is not there yet
 * (idempotently, paid for by the depositor), `units` moved into it with the
 * mint and decimals checked, and the memo that says whose it is.
 */
export function usdcDepositTransaction({ payer, from, treasury, to, mint, units, blockhash, memo }) {
  const create = {
    program: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { key: payer, writable: true },
      { key: to, writable: true },
      { key: treasury, writable: false },
      { key: mint, writable: false },
      { key: SYSTEM_PROGRAM, writable: false },
      { key: TOKEN_PROGRAM, writable: false },
    ],
    data: new Uint8Array([1]),
  };
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked
  new DataView(data.buffer).setBigUint64(1, BigInt(units), true);
  data[9] = USDC_DECIMALS;
  const transfer = {
    program: TOKEN_PROGRAM,
    keys: [
      { key: from, writable: true },
      { key: mint, writable: false },
      { key: to, writable: true },
      { key: payer, writable: false },
    ],
    data,
  };
  const note = { program: MEMO_PROGRAM, keys: [], data: new TextEncoder().encode(memo) };
  return compileTransaction(payer, [create, transfer, note], blockhash);
}

/** The account `owner` holds USDC in, asked of the server. */
export async function usdcAccountOf(owner) {
  const response = await fetch(`/chain/usdc-account?owner=${encodeURIComponent(owner)}`);
  if (!response.ok) throw new Error(`no USDC account from the server (${response.status})`);
  return (await response.json()).address;
}

/**
 * Dollars typed by a person as USDC base units, digit by digit: "5.25" is
 * exactly 5,250,000. Null if it is not an amount.
 */
export function parseUsdc(text) {
  const match = /^\s*\$?\s*(\d{1,9})(?:\.(\d{0,6}))?\s*$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/**
 * A recent blockhash, for a transaction to be built on - asked of this
 * game's server, which asks the cluster, so the cluster's endpoint (and any
 * key in it) stays the server's.
 */
export async function latestBlockhash() {
  const response = await fetch('/chain/blockhash', { cache: 'no-store' });
  if (!response.ok) throw new Error(`no blockhash from the server (${response.status})`);
  const { blockhash } = await response.json();
  if (!blockhash) throw new Error('no blockhash from the server');
  return blockhash;
}

// ---- the Wallet Standard ----------------------------------------------------
//
// How a page finds wallets without knowing any of them by name: the page
// announces itself with an event carrying a `register` function, and every
// wallet extension - already loaded, or loading later - registers through it.
// It is the protocol `@wallet-standard/app` implements, in a few lines.

let registry = null;

/**
 * Calls `onChange` with the wallets this browser has that can sign in and
 * pay on Solana, now and whenever another registers.
 */
export function watchWallets(onChange) {
  if (!registry) {
    registry = { wallets: new Set(), listeners: new Set() };
    const changed = () => {
      const usable = [...registry.wallets].filter(canSolana);
      for (const listener of registry.listeners) listener(usable);
    };
    const api = Object.freeze({
      register(...wallets) {
        for (const wallet of wallets) registry.wallets.add(wallet);
        changed();
        return () => {
          for (const wallet of wallets) registry.wallets.delete(wallet);
          changed();
        };
      },
    });
    registry.changed = changed;
    window.addEventListener('wallet-standard:register-wallet', (event) => {
      try {
        event.detail?.(api);
      } catch (err) {
        console.warn('a wallet failed to register:', err);
      }
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  }
  registry.listeners.add(onChange);
  onChange([...registry.wallets].filter(canSolana));
}

function canSolana(wallet) {
  const features = wallet?.features ?? {};
  return (
    Boolean(features['standard:connect'] && features['solana:signMessage']) &&
    (wallet.chains ?? []).some((chain) => String(chain).startsWith('solana:'))
  );
}

/** Connects, and returns the first Solana account the wallet offers. */
export async function connect(wallet) {
  const { accounts } = await wallet.features['standard:connect'].connect();
  const account = (accounts ?? wallet.accounts ?? []).find((a) =>
    (a.chains ?? wallet.chains ?? []).some((chain) => String(chain).startsWith('solana:')),
  );
  if (!account) throw new Error('the wallet offered no Solana account');
  return account;
}

/** Has the wallet sign `text`, and returns the signature in base58. */
export async function signText(wallet, account, text) {
  const [out] = await wallet.features['solana:signMessage'].signMessage({
    account,
    message: new TextEncoder().encode(text),
  });
  return base58(out.signature);
}

/** Whether the wallet can sign and send a transaction itself. */
export function canSend(wallet) {
  return Boolean(wallet?.features?.['solana:signAndSendTransaction']);
}

/** Has the wallet sign and send `transaction`; returns its signature. */
export async function signAndSend(wallet, account, transaction, chain) {
  const [out] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
    account,
    transaction,
    chain,
  });
  return base58(out.signature);
}
