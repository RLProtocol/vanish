# Vanish

A zero-knowledge privacy pool on **Solana** for **SOL, USDC/USDT/USDG and tokenized stocks** (xStocks and Backpack Securities via Sunrise).
Tornado Nova-style: deposits are fixed sizes, withdrawals can be any amount, and the remainder stays private as change. v2 adds
**private swaps** between listed assets inside the pool and **private buys** of any Jupiter-routable token (pump.fun included)
delivered to a fresh wallet. See [docs/v2-shielded-swaps.md](docs/v2-shielded-swaps.md).

The on-chain program, its crate (`programs/solmix`) and the key-derivation domains keep their original `solmix` names:
renaming those would change program addresses or users' keys.

> ⚠️ Unaudited, single-party trusted setup, upgradeable program. Don't shield value you can't lose.
> The Robinhood Chain version (RobinMix) is archived in [`legacy/robinhood/`](legacy/robinhood/ARCHIVED.md); its mainnet pool is still live.

| Asset | Issuer | Deposit sizes |
|---|---|---|
| SOL | native | 0.1 / 1 / 5 / 20 |
| USDC, USDT, USDG | Circle, Tether, Paxos | 10 / 100 / 500 / 1000 |
| NVDAx TSLAx AAPLx SPYx QQQx MSTRx COINx HOODx | xStocks (Token-2022, 8 dp) | 0.1 / 1 / 10 / 50 shares |
| SPCX, MSTR | Backpack · Sunrise (Token-2022, 6 dp) | 0.1 / 1 / 10 / 50 shares |

Every mint was read from mainnet before listing (`sdk/assets.js`). xStocks mints match Backed's official API.

## Mainnet deployment

| | Address |
|---|---|
| Program | [`92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG`](https://solscan.io/account/92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG) |
| Pool (tree + admin) | [`62Wqof98pvzhxJRabmgBeUitrQ48rg3SchZV92Hb5ojj`](https://solscan.io/account/62Wqof98pvzhxJRabmgBeUitrQ48rg3SchZV92Hb5ojj) |
| SOL vault | [`9WxUTgEZZ1x1qUm27jHvfUr54Gw2zoDzHL9isankZhQ5`](https://solscan.io/account/9WxUTgEZZ1x1qUm27jHvfUr54Gw2zoDzHL9isankZhQ5) |
| Lookup table | [`7BUtskptqD7Le3dhY4mob1TvTrX7BZjiS3y9y7WxsgEk`](https://solscan.io/account/7BUtskptqD7Le3dhY4mob1TvTrX7BZjiS3y9y7WxsgEk) |
| Upgrade authority / admin | `JA5KQPU3aZbGZaGQ5yj5igtEXJm6tqpqxgTRrgcatAAC` |

Deployed in slot 454166213. Check it with `node scripts/verify-mainnet.mjs [payer.json]`: 33 read-only checks plus a simulated 0.1 SOL shield with a real proof (~195k CU, 915-byte transaction).

RPC notes: `api.mainnet-beta.solana.com` refuses browser requests (403), so the web app defaults to PublicNode,
which rejects `getMultipleAccounts` batches over 10 accounts. The SDK chunks to 10 and paces history sync for public endpoints.

## How it works

The circuit is the same one RobinMix used (`circuits/transaction.circom`, 2-in/2-out Groth16, ~28k constraints):

```
commitment = Poseidon(amount, pubkey, blinding, assetId)     assetId = first 31 bytes of the mint (SOL = 0)
nullifier  = Poseidon(commitment, index, Poseidon(privkey, commitment, index))
```

The Solana program (`programs/solmix`, Anchor 0.31.1):

- verifies proofs with `groth16-solana` (alt_bn128 syscalls) and hashes the depth-20 Merkle tree with the Poseidon syscall;
- binds recipient, relayer, fee, mint and both encrypted notes into the proof (`keccak256(...) mod p`);
- marks a note spent by creating a `["nullifier", n]` account, so a second spend fails (~0.002 SOL rent per transaction);
- holds SOL in a `["sol_vault"]` PDA and tokens in the pool's associated token accounts (SPL Token and Token-2022);
- checks the vault receives exactly the deposit, so fee-charging tokens are rejected;
- emits a `TransactEvent` with the new commitments and 68-byte encrypted notes, which wallets scan to find their notes.

The admin can list assets and pause deposits. Withdrawals can't be paused by the admin.
Issuers can still freeze, pause or (xStocks, Backpack, USDG) move tokens out of any account, including the pool's vaults.

## Layout

```
programs/solmix/      Anchor program (lib.rs) + generated verifying_key.rs
circuits/, build/     circuit and proving key (shared with RobinMix)
sdk/                  JS client used by tests, CLI, relayer and web (Node + browser)
cli/                  Vanish CLI (vanish.mjs) and relayer
scripts/              vk-to-rust, setup (pool init + assets + lookup table), wsl-setup
tests/                sdk.test.mjs (no chain), pool.test.mjs (local validator)
web/                  frontend (Vite + React)
legacy/robinhood/     archived EVM version
```

## Build and test (WSL)

Windows Smart App Control blocks unsigned toolchains, so the program builds inside WSL.

```bash
# PowerShell (admin), once:  wsl --install   then reboot and create the Ubuntu user
cd /mnt/c/Users/<you>/OneDrive/Desktop/RobinMix
bash scripts/wsl-setup.sh          # Rust, Agave, Anchor 0.31.1, Node
npm install
node scripts/vk-to-rust.mjs        # verifying key -> programs/solmix/src/verifying_key.rs
anchor build
anchor test                        # local validator + tests/*.test.mjs
```

The SDK unit tests also run on Windows: `node --test tests/sdk.test.mjs`.

## Deploy to mainnet

```bash
solana program deploy target/deploy/solmix.so --program-id target/deploy/solmix-keypair.json -u mainnet-beta
ADMIN_KEYPAIR=keys/deployer.json RPC_URL=<rpc> node scripts/setup.mjs   # pool, assets, lookup table
```

`target/deploy/solmix-keypair.json` fixes the program address (`92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG`). It isn't in git, so back it up.

## Web

```bash
cd web && npm install && npm run dev
```

Phantom, Solflare and Backpack are supported. One signature unlocks your private balance, and proofs run in a Web Worker.
Bring your own RPC in Settings, since the public RPC is rate limited.

## CLI

```bash
node cli/vanish.mjs keygen
WALLET_KEYPAIR=~/id.json node cli/vanish.mjs shield --asset SOL --amount 1
node cli/vanish.mjs unshield --asset NVDAx --amount 3.5 --to <wallet> --relayer https://...
RELAYER_KEYPAIR=relayer.json FEE_BPS=30 node cli/relayer.mjs
```
