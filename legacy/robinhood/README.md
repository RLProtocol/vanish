# RobinMix

A hobby shielded pool for **Robinhood Chain** (Arbitrum L2, chain 4663) supporting **ETH, USDG and Robinhood Stock Tokens**.
Tornado Cash–style privacy with a Tornado Nova–style UTXO circuit, so:

- **Deposits are fixed denominations** (bigger anonymity sets)
- **Withdrawals can be any amount**; the remainder stays in the pool as a private change note

| Asset | Deposit sizes |
|---|---|
| ETH | 0.01 / 0.1 / 0.5 / 1 |
| USDG (6 decimals) | 10 / 100 / 500 / 1000 |
| Stock Tokens (shares) | 1 / 10 / 50 / 100 |

Edit `config/assets.json` to change sizes or which stocks are enabled (any of the 195 in `robinhood_stock_tokens.csv`).

> ⚠️ Unaudited hobby code with a single-party trusted setup. Don't put real value in it that you can't lose.

## How it works

```
note        = (amount, pubkey, blinding, assetId)        assetId = token address (ETH = 0)
commitment  = Poseidon(amount, pubkey, blinding, assetId)  -> leaf in one shared Merkle tree (depth 20)
nullifier   = Poseidon(commitment, leafIndex, Poseidon(privkey, commitment, leafIndex))
```

Every transaction is a 2-in / 2-out Groth16 proof (`circuits/transaction.circom`, ~28k constraints) that shows:
- the inputs exist in the tree and belong to you (without revealing which leaves),
- `sum(in) + publicAmount == sum(out)`, all for the **same** asset,
- recipient, relayer, fee and token are bound into the proof (`extDataHash`), so a relayer can't redirect funds.

| Action | publicAmount | Contract rule |
|---|---|---|
| Deposit | `+amount` | must be a registered denomination, fee = 0 |
| Withdraw | `-(amount)` | any amount; change → new private note |
| Merge | `0` | combines 2 notes into 1 (automatic when a withdrawal needs >2) |

Notes are AES-GCM-encrypted to your own key and emitted on-chain, so your wallet can always be rebuilt from `.robinmix/wallet.json` + chain history.
The owner can add assets/denominations and **pause deposits only**; nobody can block withdrawals.

Stock Tokens handle dividends/splits via an on-chain multiplier (ERC-8056) with a static raw balance, so the pool just holds raw units and the corporate-action value carries through to whoever withdraws.

## Mainnet deployment (Robinhood Chain, 4663)

| Contract | Address | Source |
|---|---|---|
| RobinMix (pool) | [`0xA52573C46fC04B56d161B1EF497dFA4Bf3ca65aA`](https://robin.etherscan.io/address/0xA52573C46fC04B56d161B1EF497dFA4Bf3ca65aA) | [Sourcify exact match](https://repo.sourcify.dev/4663/0xA52573C46fC04B56d161B1EF497dFA4Bf3ca65aA) |
| Groth16Verifier | [`0xB776926130e0593A3249A7748Ea550E0FD524B59`](https://robin.etherscan.io/address/0xB776926130e0593A3249A7748Ea550E0FD524B59) | [Sourcify exact match](https://repo.sourcify.dev/4663/0xB776926130e0593A3249A7748Ea550E0FD524B59) |
| PoseidonT3 hasher | [`0x4B3642b8E637eeb8f4B06F899467Bdd12D8c0482`](https://robin.etherscan.io/address/0x4B3642b8E637eeb8f4B06F899467Bdd12D8c0482) | circomlibjs bytecode, checked by `npm run verify:mainnet` |

Verify on robin.etherscan.io: put `ETHERSCAN_API_KEY` in `.env`, then `npm run verify:mainnet`.

Deployed at block 72084247. All asset addresses are in `deployments/rhMainnet.json`.
The verifier only accepts proofs made with `build/circuits/transaction.zkey`, so that file (and the wasm) must stay with this deployment.

## Web app (`web/`)

Landing page + app (connect wallet, shield, unshield, activity) for the mainnet pool.

```bash
cd web
npm install
npm run dev        # copies proving key + deployment into the app, then starts Vite
npm run build      # static site in web/dist (host anywhere; ~16 MB incl. proving key)
```

- Your private key is derived from one wallet signature, so the same wallet unlocks the same balance on any device. CLI key files can be imported too.
- Proofs are generated in the browser in a Web Worker; the 12 MB proving key downloads once when you unlock.
- Unshield through a relayer (`npm run relayer`, paste its URL) so your wallet never appears; paying gas yourself is allowed but warned against.

## Layout

```
circuits/            transaction.circom (JoinSplit), merkleproof.circom, keypair.circom
contracts/           RobinMix.sol, MerkleTreeWithHistory.sol, Verifier.sol (generated), mocks/
src/lib/             crypto (keys, notes, encryption), merkleTree, transaction (prover), client (sync/deposit/withdraw)
src/cli.js           command line wallet
src/relayer.js       minimal withdrawal relayer
scripts/             build-circuits.sh, deploy.js
test/                end-to-end tests with real proofs
build/circuits/      wasm + zkey (must match the deployed Verifier.sol - keep them together)
```

## Setup

```bash
npm install
npm test                      # 10 tests, real Groth16 proofs against a local chain
```

To rebuild the circuit (only needed if you change it; this regenerates `Verifier.sol` and the zkey):

```bash
# circom 2.2.x binary -> tools/circom.exe ; PSE perpetual powers of tau 2^15 -> tools/pot15.ptau
curl -L -o tools/circom.exe https://github.com/iden3/circom/releases/download/v2.2.2/circom-windows-amd64.exe
curl -L -o tools/pot15.ptau https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau
npm run circuits
```

## Try it locally

```bash
npx hardhat node                                   # terminal 1
npx hardhat run scripts/deploy.js --network localhost
cp .env.example .env   # set PRIVATE_KEY to a hardhat test key

node src/cli.js keygen
node src/cli.js mint     --network localhost --asset NVDA --amount 100
node src/cli.js deposit  --network localhost --asset ETH  --amount 0.5
node src/cli.js deposit  --network localhost --asset NVDA --amount 10
node src/cli.js balance  --network localhost
node src/cli.js withdraw --network localhost --asset ETH  --amount 0.1337 --to 0xRecipient
```

With a relayer (recommended: your own address never touches the withdrawal):

```bash
RELAYER_PRIVATE_KEY=0x... NETWORK=localhost PORT=8000 FEE_BPS=30 node src/relayer.js
node src/cli.js withdraw --network localhost --asset NVDA --amount 3.25 --to 0xRecipient --relayer http://127.0.0.1:8000
```

## Testnet / mainnet

```bash
npm run deploy:testnet   # chain 46630, deploys mock USDG + mock stocks (mintable via `cli mint`)
npm run deploy:mainnet   # chain 4663, real USDG (0x5fc5…d168) + stocks from config/assets.json
```

The mainnet deploy checks each token's on-chain symbol/decimals before registering it.
Stock Tokens are **not available to US persons** and are restricted in several other jurisdictions; the issuer can also restrict token transfers.

## Privacy tips (the math only helps if usage is careful)

- **Anonymity set = deposits of the same asset.** 195 stocks → very thin sets per ticker. Enable a few popular ones, not all.
- **Custom withdrawal amounts fingerprint you.** Depositing 1 ETH and withdrawing 0.7342 ETH plus 0.2658 ETH later is linkable. Prefer round amounts or whole denominations.
- **Wait.** Deposit → immediate withdraw is trivially linked by timing.
- **Gas leaks identity.** Withdraw through a relayer, or from a fresh address funded without touching your deposit address.
- Back up `.robinmix/wallet.json`. Lose it and the notes are gone; leak it and they're spendable by anyone.

## Known limitations / to-do

- Single-contributor phase-2 setup: whoever ran `npm run circuits` could forge proofs. Run a multi-party ceremony before holding real value.
- No audit. No compliance/association-set layer (see Privacy Pools if you want one).
- Notes can only be sent to yourself (no shielded transfers to other users yet).
- Public RPC is rate limited; long histories scan in chunks and are cached in `.robinmix/`.
