# RobinMix (Robinhood Chain) — archived

Parked while the project focuses on SolMix (Solana). Nothing here is built or deployed by the active repo.

- Mainnet deployment (still live): pool `0xA52573C46fC04B56d161B1EF497dFA4Bf3ca65aA` on Robinhood Chain (4663), see `deployments/rhMainnet.json`.
- Contracts verified on Sourcify; see `README.md` in this folder for the original docs.

## Restore

The circuit (`/circuits`) and proving key (`/build/circuits`) are shared with SolMix and were not moved.

```bash
cd legacy/robinhood
npm install            # hardhat, ethers, snarkjs, circomlibjs ...
npx hardhat test       # contracts expect build/circuits at ../../build/circuits (adjust paths in src/lib/transaction.js)
cd web && npm install && npm run dev
```

Paths that pointed at the repo root (`build/circuits`, `deployments/`) need `../../` once moved back or run from here.
