//! Solana, on devnet, and the one place this server touches a chain.
//!
//! # What this is for
//!
//! The ledger is the truth about who owns what, and playing never touches a
//! chain: entry fees and kill rewards move between internal accounts in
//! Postgres, in micro-USD, at the speed of a database. Real money crosses the
//! boundary exactly twice - **a deposit in and a withdrawal out** - and this
//! module is both of those crossings.
//!
//! # Why this is hand-rolled
//!
//! The whole of what the server does on chain is: read a balance, read recent
//! transactions to one address, and send one system transfer. That is a
//! JSON-RPC call, an ed25519 signature and a byte layout that has not changed.
//! `solana-sdk` does the same job and brings several hundred crates to do it
//! with, onto a build that is already the slowest thing in the loop.
//!
//! The format is documented and small enough to state here in full, which is
//! the argument for writing it out: a reader can check this against the spec.
//! A transaction is
//!
//! ```text
//!   compact-array of 64-byte signatures
//!   message:
//!     3 header bytes  - signers, readonly signers, readonly non-signers
//!     compact-array of 32-byte account addresses
//!     32-byte recent blockhash
//!     compact-array of instructions
//!   instruction:
//!     1 byte program index into the account array
//!     compact-array of 1-byte account indices
//!     compact-array of data bytes
//! ```
//!
//! where a compact array is a shortvec length followed by its elements. The
//! signature is ed25519 over the serialised message.
//!
//! # Devnet only
//!
//! [`Cluster::DEVNET`] is the only endpoint this will talk to unless something
//! explicitly hands it another, and `main` never does. Nothing here should be
//! able to move mainnet funds by accident - see the note in `CLAUDE.md`, which
//! is not a style preference.

use anyhow::{Context, Result, bail};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};

/// Lamports in one SOL.
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// The system program, which owns plain SOL transfers.
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";

/// The memo program. A deposit says who it is for by attaching one.
const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/// `SystemInstruction::Transfer`, which is variant 2.
const TRANSFER: u32 = 2;

/// A 32-byte account address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address(pub [u8; 32]);

impl Address {
    pub fn parse(text: &str) -> Result<Self> {
        let raw = bs58::decode(text)
            .into_vec()
            .with_context(|| format!("{text:?} is not base58"))?;
        let bytes: [u8; 32] = raw
            .try_into()
            .map_err(|_| anyhow::anyhow!("{text:?} is not 32 bytes, so it is not an address"))?;
        Ok(Address(bytes))
    }
}

impl std::fmt::Display for Address {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&bs58::encode(self.0).into_string())
    }
}

/// The treasury's keypair: the one thing here that can move money.
///
/// Read from `SOLATEL_TREASURY_KEY` as base58, which is where a secret
/// belongs - not in the repository, and not in an argument list where it would
/// show up in `ps`. [`Treasury::generate`] makes one for a devnet server that
/// has none yet and prints it once so it can be saved.
pub struct Treasury {
    key: SigningKey,
    pub address: Address,
}

impl Treasury {
    pub fn from_base58(secret: &str) -> Result<Self> {
        let raw = bs58::decode(secret.trim())
            .into_vec()
            .context("the treasury key is not base58")?;
        // Both shapes are in the wild: a bare 32-byte seed, and the 64-byte
        // "keypair" that is the seed followed by the public key.
        let seed: [u8; 32] = match raw.len() {
            32 => raw[..32].try_into().expect("just checked"),
            64 => raw[..32].try_into().expect("just checked"),
            n => bail!("a treasury key is 32 or 64 bytes; this one is {n}"),
        };
        Ok(Self::from_seed(seed))
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        let key = SigningKey::from_bytes(&seed);
        let address = Address(key.verifying_key().to_bytes());
        Self { key, address }
    }

    /// A fresh keypair, for a devnet server that has none.
    pub fn generate() -> Result<(Self, String)> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed)
            .map_err(|err| anyhow::anyhow!("no randomness to make a key from: {err}"))?;
        let treasury = Self::from_seed(seed);
        Ok((treasury, bs58::encode(seed).into_string()))
    }
}

/// Where to talk to, and nothing else.
#[derive(Debug, Clone)]
pub struct Cluster(String);

impl Cluster {
    /// The only cluster this server is built to speak to.
    pub const DEVNET: &'static str = "https://api.devnet.solana.com";

    pub fn devnet() -> Self {
        Cluster(Self::DEVNET.to_string())
    }
}

/// A JSON-RPC client for the handful of calls this server makes.
pub struct Rpc {
    http: reqwest::Client,
    cluster: Cluster,
}

/// Transfers below this cannot open a new account, so the chain refuses
/// them: an address with no SOL in it has to be paid at least enough to be
/// rent-exempt. 890,880 lamports is that figure for an account holding no
/// data, which is what a wallet is.
pub const RENT_EXEMPT_MINIMUM: u64 = 890_880;

/// What the treasury pays to send one transaction with one signature.
pub const SIGNATURE_FEE: u64 = 5_000;

/// A signed transaction, with what is needed to send it again and to know
/// when it can no longer land.
pub struct Signed {
    /// The transaction's first signature, which is its id. Known the moment
    /// it is signed - before anything is sent - which is what lets it be
    /// recorded first and sent afterwards.
    pub signature: String,
    /// The wire bytes, base64, exactly as sent. Sending them again is the
    /// same transaction, and the chain will not run it twice.
    pub wire_base64: String,
    /// Past this block height the blockhash it was signed against has
    /// expired, and it can never be included.
    pub last_valid_block_height: u64,
}

/// One signature from an address's history.
#[derive(Debug, Clone)]
pub struct Seen {
    pub signature: String,
    /// It ran and failed. Nothing moved, and there is no need to fetch it.
    pub failed: bool,
}

/// One transfer into the treasury, as the chain reports it.
#[derive(Debug, Clone)]
pub struct Incoming {
    /// The transaction signature, which is what makes a deposit idempotent:
    /// it is unique, it is the chain's own name for the event, and it is what
    /// the ledger key is built from.
    pub signature: String,
    /// What the memo said, which is how a deposit says who it is for.
    pub memo: Option<String>,
    /// How much the treasury gained, in lamports.
    pub lamports: u64,
    /// Block time, seconds since the epoch, when the chain reports one.
    pub at: Option<i64>,
}

impl Rpc {
    pub fn new(cluster: Cluster) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("building the Solana HTTP client")?;
        Ok(Self { http, cluster })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let response: Value = self
            .http
            .post(&self.cluster.0)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("calling {method}"))?
            .json()
            .await
            .with_context(|| format!("reading the answer to {method}"))?;

        if let Some(error) = response.get("error") {
            bail!("{method} failed: {error}");
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// What an address holds, in lamports.
    pub async fn balance(&self, address: Address) -> Result<u64> {
        let result = self
            .call("getBalance", json!([address.to_string()]))
            .await?;
        Ok(result
            .get("value")
            .and_then(Value::as_u64)
            .unwrap_or_default())
    }

    /// Ask devnet for some SOL. Devnet only, and rate limited by the faucet.
    pub async fn airdrop(&self, address: Address, lamports: u64) -> Result<String> {
        let result = self
            .call("requestAirdrop", json!([address.to_string(), lamports]))
            .await?;
        result
            .as_str()
            .map(str::to_string)
            .context("the faucet answered without a signature")
    }

    /// A blockhash recent enough for a transaction to be accepted, and the
    /// last block height at which a transaction signed against it can land.
    pub async fn recent_blockhash(&self) -> Result<([u8; 32], u64)> {
        let result = self
            .call("getLatestBlockhash", json!([{"commitment": "finalized"}]))
            .await?;
        let value = result.get("value").context("no blockhash in the answer")?;
        let text = value
            .get("blockhash")
            .and_then(Value::as_str)
            .context("no blockhash in the answer")?;
        let last_valid = value
            .get("lastValidBlockHeight")
            .and_then(Value::as_u64)
            .context("no lastValidBlockHeight in the answer")?;
        Ok((Address::parse(text)?.0, last_valid))
    }

    /// The newest block height the cluster has finalized.
    pub async fn finalized_height(&self) -> Result<u64> {
        self.call("getBlockHeight", json!([{"commitment": "finalized"}]))
            .await?
            .as_u64()
            .context("getBlockHeight answered without a number")
    }

    /// Finalized transactions involving an address, newest first.
    ///
    /// `before` pages backwards: pass the oldest signature of one page to get
    /// the page before it. Finalized only, because the caller credits money
    /// on what it finds, and money is not credited on a transaction the
    /// chain could still take back.
    pub async fn signatures_for(
        &self,
        address: Address,
        limit: u32,
        before: Option<&str>,
    ) -> Result<Vec<Seen>> {
        let mut options = json!({ "limit": limit, "commitment": "finalized" });
        if let Some(before) = before {
            options["before"] = json!(before);
        }
        let result = self
            .call(
                "getSignaturesForAddress",
                json!([address.to_string(), options]),
            )
            .await?;
        Ok(result
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let signature = row.get("signature").and_then(Value::as_str)?;
                        Some(Seen {
                            signature: signature.to_string(),
                            failed: row.get("err").is_some_and(|e| !e.is_null()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// What one transaction did to the treasury, if it paid it anything.
    ///
    /// The amount is read from the balance the chain recorded either side of
    /// the transaction rather than by decoding the instruction, because that
    /// is what actually landed: a transaction can pay an address in more ways
    /// than one, and the difference is the only number that is true of all of
    /// them.
    pub async fn incoming(&self, signature: &str, treasury: Address) -> Result<Option<Incoming>> {
        let result = self
            .call(
                "getTransaction",
                json!([
                    signature,
                    {
                        "encoding": "jsonParsed",
                        "maxSupportedTransactionVersion": 0,
                        "commitment": "finalized"
                    }
                ]),
            )
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        if result
            .get("meta")
            .and_then(|m| m.get("err"))
            .is_some_and(|e| !e.is_null())
        {
            // It failed on chain. Nothing moved.
            return Ok(None);
        }

        let keys: Vec<String> = result
            .pointer("/transaction/message/accountKeys")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        row.get("pubkey")
                            .and_then(Value::as_str)
                            .or_else(|| row.as_str())
                    })
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let wanted = treasury.to_string();
        let Some(index) = keys.iter().position(|k| *k == wanted) else {
            return Ok(None);
        };

        let before = result
            .pointer("/meta/preBalances")
            .and_then(Value::as_array)
            .and_then(|a| a.get(index))
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let after = result
            .pointer("/meta/postBalances")
            .and_then(Value::as_array)
            .and_then(|a| a.get(index))
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let Some(gained) = after.checked_sub(before).filter(|n| *n > 0) else {
            // It did not pay the treasury. A withdrawal this server sent is
            // the usual reason, and it is not a deposit.
            return Ok(None);
        };

        Ok(Some(Incoming {
            signature: signature.to_string(),
            memo: read_memo(&result),
            lamports: gained,
            at: result.get("blockTime").and_then(Value::as_i64),
        }))
    }

    /// Sign a transfer out of `from`, without sending it.
    ///
    /// Separate from sending on purpose. The signature is the transaction's
    /// id and it exists the moment this returns, so the caller can write it
    /// down *before* anything goes to the network - and a transfer whose
    /// signature is on record is one that can be sent again, or waited out,
    /// without ever being paid twice.
    pub async fn sign_transfer(
        &self,
        from: &Treasury,
        to: Address,
        lamports: u64,
        memo: Option<&str>,
    ) -> Result<Signed> {
        let (blockhash, last_valid_block_height) = self.recent_blockhash().await?;
        let wire = build_transfer(from, to, lamports, blockhash, memo)?;
        Ok(Signed {
            signature: bs58::encode(&wire[1..65]).into_string(),
            wire_base64: base64_encode(&wire),
            last_valid_block_height,
        })
    }

    /// Hand a signed transaction to the cluster.
    ///
    /// An error here does not mean it did not land - a timeout can come back
    /// for a transaction that went through - so nothing is concluded from
    /// one. What happened is asked of [`Rpc::outcome`].
    pub async fn send(&self, wire_base64: &str) -> Result<String> {
        let result = self
            .call(
                "sendTransaction",
                json!([wire_base64, { "encoding": "base64", "preflightCommitment": "confirmed" }]),
            )
            .await?;
        result
            .as_str()
            .map(str::to_string)
            .context("the cluster accepted the transaction without naming it")
    }

    /// What has become of a transaction this server sent.
    ///
    /// Only a *finalized* answer is final. A transaction that failed in a
    /// block that is merely confirmed could still be dropped with its block
    /// and land somewhere else, and money returned on that answer would then
    /// have been paid twice.
    pub async fn outcome(&self, signature: &str) -> Result<Outcome> {
        let result = self
            .call(
                "getSignatureStatuses",
                json!([[signature], { "searchTransactionHistory": true }]),
            )
            .await?;
        let status = result.pointer("/value/0");
        let Some(status) = status.filter(|v| !v.is_null()) else {
            return Ok(Outcome::Unknown);
        };
        let finalized = status
            .get("confirmationStatus")
            .and_then(Value::as_str)
            .is_some_and(|s| s == "finalized");
        if !finalized {
            return Ok(Outcome::Pending);
        }
        if status.get("err").is_some_and(|e| !e.is_null()) {
            return Ok(Outcome::Failed);
        }
        Ok(Outcome::Finalized)
    }
}

/// What the chain says happened to something this server sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The cluster has no record of it. Either it is still on its way, or it
    /// never arrived - which of the two is decided by the blockhash expiring.
    Unknown,
    /// In a block, not yet final.
    Pending,
    /// Final, and it did what it said.
    Finalized,
    /// Final, and it failed. Nothing moved but the fee.
    Failed,
}

/// The memo attached to a transaction, wherever the RPC chose to put it.
///
/// Two shapes are in the wild: a `logMessages` line the memo program writes,
/// and a parsed instruction. Both are read, because which one comes back
/// depends on the node rather than on the transaction.
fn read_memo(transaction: &Value) -> Option<String> {
    if let Some(logs) = transaction
        .pointer("/meta/logMessages")
        .and_then(Value::as_array)
    {
        for line in logs.iter().filter_map(Value::as_str) {
            if let Some((_, rest)) = line.split_once("Program log: Memo (len ")
                && let Some((_, text)) = rest.split_once("): ")
            {
                return Some(text.trim_matches('"').to_string());
            }
        }
    }
    let instructions = transaction
        .pointer("/transaction/message/instructions")
        .and_then(Value::as_array)?;
    for instruction in instructions {
        let program = instruction.get("program").and_then(Value::as_str);
        let program_id = instruction.get("programId").and_then(Value::as_str);
        if (program == Some("spl-memo") || program_id == Some(MEMO_PROGRAM))
            && let Some(parsed) = instruction.get("parsed").and_then(Value::as_str)
        {
            return Some(parsed.to_string());
        }
    }
    None
}

/// Shortvec: a length, seven bits at a time, low group first.
fn shortvec(len: usize, out: &mut Vec<u8>) {
    let mut rest = len;
    loop {
        let mut byte = (rest & 0x7f) as u8;
        rest >>= 7;
        if rest == 0 {
            out.push(byte);
            return;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

/// One signed system transfer, ready to send, with a memo if one is given.
///
/// The account list is ordered the way the format requires: writable signers,
/// then writable non-signers, then read-only. Here that is the payer (it
/// signs and it pays), the recipient (it is paid), the system program, and
/// the memo program when there is a memo.
///
/// The memo instruction names no accounts. The memo program will check any
/// signers it is given and needs none, and a memo that asked for the payer's
/// signature would only be a second way for the transaction to fail.
fn build_transfer(
    from: &Treasury,
    to: Address,
    lamports: u64,
    blockhash: [u8; 32],
    memo: Option<&str>,
) -> Result<Vec<u8>> {
    let system = Address::parse(SYSTEM_PROGRAM)?;
    let memo_program = Address::parse(MEMO_PROGRAM)?;
    let mut accounts = vec![from.address, to, system];
    if memo.is_some() {
        accounts.push(memo_program);
    }

    let mut message = Vec::with_capacity(200);
    // One required signature, no read-only signers, and the programs as
    // read-only non-signers - neither is written to or signs.
    message.extend_from_slice(&[1, 0, (accounts.len() - 2) as u8]);
    shortvec(accounts.len(), &mut message);
    for account in &accounts {
        message.extend_from_slice(&account.0);
    }
    message.extend_from_slice(&blockhash);

    shortvec(if memo.is_some() { 2 } else { 1 }, &mut message);

    // Transfer, from account 0 to account 1, run by the program at index 2.
    message.push(2);
    shortvec(2, &mut message);
    message.extend_from_slice(&[0, 1]);
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&TRANSFER.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    shortvec(data.len(), &mut message);
    message.extend_from_slice(&data);

    // The memo: the program at index 3, no accounts, the text as its data.
    if let Some(memo) = memo {
        message.push(3);
        shortvec(0, &mut message);
        shortvec(memo.len(), &mut message);
        message.extend_from_slice(memo.as_bytes());
    }

    let signature = from.key.sign(&message);

    let mut wire = Vec::with_capacity(message.len() + 72);
    shortvec(1, &mut wire);
    wire.extend_from_slice(&signature.to_bytes());
    wire.extend_from_slice(&message);
    Ok(wire)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortvec_matches_the_documented_encoding() {
        let mut out = Vec::new();
        shortvec(0, &mut out);
        assert_eq!(out, vec![0]);

        out.clear();
        shortvec(5, &mut out);
        assert_eq!(out, vec![5]);

        // 0x80 is where a second byte starts: seven bits to a group.
        out.clear();
        shortvec(0x80, &mut out);
        assert_eq!(out, vec![0x80, 0x01]);

        out.clear();
        shortvec(0x4000, &mut out);
        assert_eq!(out, vec![0x80, 0x80, 0x01]);
    }

    #[test]
    fn an_address_survives_the_round_trip() {
        let system = Address::parse(SYSTEM_PROGRAM).unwrap();
        assert_eq!(system.0, [0u8; 32], "the system program is all zeroes");
        assert_eq!(system.to_string(), SYSTEM_PROGRAM);
    }

    #[test]
    fn rubbish_is_not_an_address() {
        assert!(Address::parse("").is_err());
        assert!(Address::parse("not base58 at all!!").is_err());
        // Valid base58, wrong length.
        assert!(Address::parse("abc").is_err());
    }

    #[test]
    fn a_key_gives_the_same_address_every_time() {
        let treasury = Treasury::from_seed([7u8; 32]);
        let again = Treasury::from_seed([7u8; 32]);
        assert_eq!(treasury.address, again.address);
        // And a different seed is a different address.
        assert_ne!(treasury.address, Treasury::from_seed([8u8; 32]).address);
    }

    #[test]
    fn a_sixty_four_byte_keypair_is_read_as_its_seed() {
        let treasury = Treasury::from_seed([3u8; 32]);
        let mut pair = Vec::with_capacity(64);
        pair.extend_from_slice(&[3u8; 32]);
        pair.extend_from_slice(&treasury.address.0);
        let read = Treasury::from_base58(&bs58::encode(&pair).into_string()).unwrap();
        assert_eq!(read.address, treasury.address);
    }

    #[test]
    fn a_transfer_is_the_shape_the_chain_expects() {
        let treasury = Treasury::from_seed([1u8; 32]);
        let to = Treasury::from_seed([2u8; 32]).address;
        let wire = build_transfer(&treasury, to, 12_345, [9u8; 32], None).unwrap();

        // One signature, then the message.
        assert_eq!(wire[0], 1, "one signature");
        let message = &wire[1 + 64..];
        assert_eq!(&message[0..3], &[1, 0, 1], "one signer, one read-only");
        assert_eq!(message[3], 3, "three accounts");

        // The accounts, in the order the format requires.
        assert_eq!(&message[4..36], &treasury.address.0);
        assert_eq!(&message[36..68], &to.0);
        assert_eq!(&message[68..100], &[0u8; 32], "the system program");
        assert_eq!(&message[100..132], &[9u8; 32], "the blockhash");

        // One instruction, run by account 2, over accounts 0 and 1.
        assert_eq!(&message[132..137], &[1, 2, 2, 0, 1]);
        assert_eq!(message[137], 12, "four bytes of variant, eight of amount");
        assert_eq!(&message[138..142], &TRANSFER.to_le_bytes());
        assert_eq!(&message[142..150], &12_345u64.to_le_bytes());
        assert_eq!(message.len(), 150);
    }

    #[test]
    fn a_transfer_is_signed_by_the_treasury() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};

        let treasury = Treasury::from_seed([4u8; 32]);
        let to = Treasury::from_seed([5u8; 32]).address;
        for memo in [None, Some("a memo")] {
            let wire = build_transfer(&treasury, to, 1, [0u8; 32], memo).unwrap();

            let signature = Signature::from_bytes(wire[1..65].try_into().unwrap());
            let key = VerifyingKey::from_bytes(&treasury.address.0).unwrap();
            assert!(
                key.verify(&wire[65..], &signature).is_ok(),
                "the chain would refuse a transaction this server signed wrong ({memo:?})"
            );
        }
    }

    #[test]
    fn a_memo_rides_as_its_own_instruction() {
        let payer = Treasury::from_seed([1u8; 32]);
        let to = Treasury::from_seed([2u8; 32]).address;
        let memo = "5f0c8a1e-0000-4000-8000-000000000001";
        let wire = build_transfer(&payer, to, 7, [9u8; 32], Some(memo)).unwrap();
        let message = &wire[1 + 64..];

        // Two programs read-only now, and four accounts.
        assert_eq!(&message[0..3], &[1, 0, 2]);
        assert_eq!(message[3], 4);
        let memo_program = Address::parse(MEMO_PROGRAM).unwrap();
        assert_eq!(&message[100..132], &memo_program.0, "the memo program");
        assert_eq!(&message[132..164], &[9u8; 32], "the blockhash");

        // Two instructions; the transfer is unchanged.
        assert_eq!(message[164], 2);
        assert_eq!(&message[165..170], &[2, 2, 0, 1, 12]);
        assert_eq!(&message[174..182], &7u64.to_le_bytes());

        // Then the memo: program 3, no accounts, the text.
        assert_eq!(&message[182..185], &[3, 0, memo.len() as u8]);
        assert_eq!(&message[185..], memo.as_bytes());
    }

    #[test]
    fn a_memo_is_read_out_of_either_shape() {
        let logged = json!({
            "meta": { "logMessages": [r#"Program log: Memo (len 4): "abcd""#] }
        });
        assert_eq!(read_memo(&logged).as_deref(), Some("abcd"));

        let parsed = json!({
            "transaction": { "message": { "instructions": [
                { "program": "spl-memo", "parsed": "hello" }
            ] } }
        });
        assert_eq!(read_memo(&parsed).as_deref(), Some("hello"));

        let neither = json!({ "meta": { "logMessages": ["Program log: something else"] } });
        assert_eq!(read_memo(&neither), None);
    }
}
