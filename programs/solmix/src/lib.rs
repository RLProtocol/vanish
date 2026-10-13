//! SolMix: a Tornado Nova-style shielded pool for SOL, stablecoins and tokenized stocks.
//!
//! Every transaction is a Groth16 proof over the shared `transaction.circom` circuit
//! (2 notes in, 2 notes out). Deposits must be one of an asset's fixed denominations;
//! withdrawals can be any amount, with the remainder kept as a private change note.
//! The admin can list assets and pause deposits, but nothing can stop a withdrawal.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use groth16_solana::groth16::Groth16Verifier;
use solana_poseidon::{hashv, Endianness, Parameters};

mod verifying_key;
use verifying_key::{NR_PUBLIC_INPUTS, VERIFYINGKEY};

pub mod swap;
pub use swap::*;
pub mod buy;
pub use buy::*;

declare_id!("92DHWjMnbgcBdEmQ3hWoiJthFbP6Bk5e513pZAsQqoUG");

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 100;
pub const MAX_DENOMINATIONS: usize = 8;
/// AES-256-GCM note: iv(12) | tag(16) | amount u64 BE(8) | blinding(32)
pub const ENCRYPTED_OUTPUT_LEN: usize = 68;
/// proof A (negated, 64) | proof B (128) | proof C (64)
pub const PROOF_LEN: usize = 256;

pub const POOL_SEED: &[u8] = b"pool";
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";
pub const ASSET_SEED: &[u8] = b"asset";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
/// Asset key used for native SOL.
pub const NATIVE_SOL: Pubkey = Pubkey::new_from_array([0u8; 32]);
/// Longest a swap / buy order may stay open.
pub const MAX_ORDER_SECS: i64 = 3600;
/// An asset can be closed only this long after deposits and new orders were paused, so no
/// order opened before the pause can still need its vault. Test builds use 5 s.
#[cfg(not(feature = "mock-swap"))]
pub const CLOSE_DELAY: i64 = MAX_ORDER_SECS + 60;
#[cfg(feature = "mock-swap")]
pub const CLOSE_DELAY: i64 = 5;

/// BN254 scalar field modulus, big-endian.
pub const FIELD_SIZE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[program]
pub mod solmix {
    use super::*;

    /// Creates the pool (Merkle tree + admin) and funds the SOL vault's rent.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_init()?;
        pool.admin = ctx.accounts.admin.key();
        let mut zero = [0u8; 32];
        for i in 0..LEVELS {
            pool.zeros[i] = zero;
            pool.filled_subtrees[i] = zero;
            zero = poseidon2(&zero, &zero)?;
        }
        pool.roots[0] = zero;
        drop(pool);

        let rent = Rent::get()?.minimum_balance(0);
        let have = ctx.accounts.sol_vault.lamports();
        if have < rent {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: ctx.accounts.sol_vault.to_account_info(),
                    },
                ),
                rent - have,
            )?;
        }
        Ok(())
    }

    /// Lists native SOL with the given deposit sizes (lamports).
    pub fn add_sol_asset(ctx: Context<AddSolAsset>, denominations: Vec<u64>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.mint = NATIVE_SOL;
        asset.decimals = 9;
        asset.paused = false;
        asset.bump = ctx.bumps.asset;
        asset.denominations = checked_denominations(denominations)?;
        ctx.accounts.pool.load_mut()?.asset_count += 1;
        Ok(())
    }

    /// Lists an SPL / Token-2022 mint and creates the pool's vault for it.
    pub fn add_token_asset(ctx: Context<AddTokenAsset>, denominations: Vec<u64>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        asset.mint = ctx.accounts.mint.key();
        asset.decimals = ctx.accounts.mint.decimals;
        asset.paused = false;
        asset.bump = ctx.bumps.asset;
        asset.denominations = checked_denominations(denominations)?;
        ctx.accounts.pool.load_mut()?.asset_count += 1;
        Ok(())
    }

    /// Changes deposit sizes and/or pauses deposits. Withdrawals are never affected.
    pub fn set_asset(ctx: Context<SetAsset>, denominations: Option<Vec<u64>>, paused: Option<bool>) -> Result<()> {
        let asset = &mut ctx.accounts.asset;
        if let Some(d) = denominations {
            asset.denominations = checked_denominations(d)?;
        }
        if let Some(p) = paused {
            if p && !asset.paused {
                asset.paused_at = Clock::get()?.unix_timestamp;
            }
            asset.paused = p;
        }
        Ok(())
    }

    /// Reclaims an asset's rent once nobody can need it: paused for CLOSE_DELAY (so no order
    /// opened before the pause is still running) and its vault empty (so no note has value).
    pub fn close_asset(ctx: Context<CloseAsset>) -> Result<()> {
        let a = &ctx.accounts;
        let asset = &a.asset;
        require!(asset.paused && Clock::get()?.unix_timestamp >= asset.paused_at + CLOSE_DELAY, SolMixError::CloseNotAllowed);
        if asset.mint == NATIVE_SOL {
            require!(a.sol_vault.lamports() <= Rent::get()?.minimum_balance(0), SolMixError::VaultNotEmpty);
        } else {
            let vault = a.vault.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
            let tp = a.token_program.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
            let expected = get_associated_token_address_with_program_id(&a.pool.key(), &asset.mint, &tp.key());
            require_keys_eq!(vault.key(), expected, SolMixError::WrongVault);
            require!(vault.amount == 0, SolMixError::VaultNotEmpty);
            let seeds: &[&[u8]] = &[POOL_SEED, &[ctx.bumps.pool]];
            token_interface::close_account(CpiContext::new_with_signer(
                tp.to_account_info(),
                token_interface::CloseAccount { account: vault.to_account_info(), destination: a.admin.to_account_info(), authority: a.pool.to_account_info() },
                &[seeds],
            ))?;
        }
        let mut pool = a.pool.load_mut()?;
        pool.asset_count = pool.asset_count.saturating_sub(1);
        Ok(())
    }

    /// Closes the pool and the SOL vault after every asset has been closed.
    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        require!(ctx.accounts.pool.load()?.asset_count == 0, SolMixError::VaultNotEmpty);
        let rent = ctx.accounts.sol_vault.lamports();
        if rent > 0 {
            let seeds: &[&[u8]] = &[SOL_VAULT_SEED, &[ctx.bumps.sol_vault]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.sol_vault.to_account_info(), to: ctx.accounts.admin.to_account_info() },
                    &[seeds],
                ),
                rent,
            )?;
        }
        Ok(())
    }

    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.pool.load_mut()?.admin = new_admin;
        Ok(())
    }

    /// Deposit (ext_amount > 0), withdraw (< 0) or private merge/split (= 0).
    pub fn transact(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
        require!(args.proof.len() == PROOF_LEN, SolMixError::InvalidProof);
        require!(
            args.encrypted_output1.len() == ENCRYPTED_OUTPUT_LEN && args.encrypted_output2.len() == ENCRYPTED_OUTPUT_LEN,
            SolMixError::InvalidEncryptedOutput
        );
        require!(args.ext_amount != i64::MIN, SolMixError::InvalidAmount);
        require!(args.fee <= i64::MAX as u64, SolMixError::InvalidAmount);
        require!(args.input_nullifiers[0] != args.input_nullifiers[1], SolMixError::DuplicateNullifier);
        for x in args.input_nullifiers.iter().chain(args.output_commitments.iter()) {
            require!(*x < FIELD_SIZE, SolMixError::FieldOverflow);
        }

        let mint_key = ctx.accounts.asset.mint;
        let is_sol = mint_key == NATIVE_SOL;

        // Everything outside the circuit that the proof must commit to.
        let ext_hash = ext_data_hash(
            &ctx.accounts.recipient.key(),
            args.ext_amount,
            &ctx.accounts.relayer.key(),
            args.fee,
            &mint_key,
            &args.encrypted_output1,
            &args.encrypted_output2,
        );
        {
            let pool = ctx.accounts.pool.load()?;
            require!(pool.is_known_root(&args.root), SolMixError::UnknownRoot);
        }
        let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
            args.root,
            public_amount(args.ext_amount, args.fee),
            ext_hash,
            asset_id(&mint_key),
            args.input_nullifiers[0],
            args.input_nullifiers[1],
            args.output_commitments[0],
            args.output_commitments[1],
        ];
        verify_proof(&args.proof, &public_inputs)?;

        if !is_sol {
            check_token_accounts(&ctx.accounts, &mint_key)?;
        }

        if args.ext_amount > 0 {
            let amount = args.ext_amount as u64;
            let asset = &ctx.accounts.asset;
            require!(!asset.paused, SolMixError::DepositsPaused);
            require!(asset.denominations.contains(&amount), SolMixError::InvalidDenomination);
            require!(args.fee == 0, SolMixError::FeeOnDeposit);
            deposit(ctx.accounts, is_sol, amount)?;
        } else if args.ext_amount < 0 {
            let to = ctx.accounts.recipient.to_account_info();
            pay_out(ctx.accounts, ctx.bumps.sol_vault, ctx.bumps.pool, is_sol, to, (-args.ext_amount) as u64)?;
        }
        if args.fee > 0 {
            let to = ctx.accounts.relayer.to_account_info();
            pay_out(ctx.accounts, ctx.bumps.sol_vault, ctx.bumps.pool, is_sol, to, args.fee)?;
        }

        let first_index = ctx
            .accounts
            .pool
            .load_mut()?
            .insert(&args.output_commitments[0], &args.output_commitments[1])?;

        emit!(TransactEvent {
            mint: mint_key,
            first_index,
            commitments: args.output_commitments,
            nullifiers: args.input_nullifiers,
            encrypted_output1: args.encrypted_output1,
            encrypted_output2: args.encrypted_output2,
            ext_amount: args.ext_amount,
            fee: args.fee,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ v2: shielded swaps

    /// Creates a swap order and proves its refund notes (deposit-shaped proof over the input asset).
    pub fn swap_prepare(ctx: Context<SwapPrepare>, order_id: [u8; 32], deadline: i64, refund: TransactArgs) -> Result<()> {
        swap::swap_prepare(ctx, order_id, deadline, refund)
    }

    /// Proves the output notes (deposit-shaped proof over the output asset, worth min_out).
    pub fn swap_commit_out(ctx: Context<SwapCommitOut>, out: TransactArgs) -> Result<()> {
        swap::swap_commit_out(ctx, out)
    }

    /// Spends the user's notes into the order's escrow; the proof binds the order's terms.
    pub fn swap_open<'info>(ctx: Context<'_, '_, '_, 'info, SwapOpen<'info>>, tx: TransactArgs) -> Result<()> {
        swap::swap_open(ctx, tx)
    }

    /// Runs the aggregator route and credits the output notes.
    pub fn swap_execute<'info>(ctx: Context<'_, '_, 'info, 'info, SwapExecute<'info>>, route_data: Vec<u8>) -> Result<()> {
        swap::swap_execute(ctx, route_data)
    }

    /// Unwinds an order; if it was opened, the refund notes are credited.
    pub fn swap_cancel(ctx: Context<SwapCancel>) -> Result<()> {
        swap::swap_cancel(ctx)
    }

    // ------------------------------------------------------------------ v2: private buy

    /// Spends notes into a buy order for any routable token, delivered to `terms.destination`.
    pub fn buy_open<'info>(ctx: Context<'_, '_, '_, 'info, BuyOpen<'info>>, order_id: [u8; 32], terms: BuyTerms, tx: TransactArgs) -> Result<()> {
        buy::buy_open(ctx, order_id, terms, tx)
    }

    /// Runs the aggregator route; at least min_out must reach the destination.
    pub fn buy_execute<'info>(ctx: Context<'_, '_, 'info, 'info, BuyExecute<'info>>, route_data: Vec<u8>) -> Result<()> {
        buy::buy_execute(ctx, route_data)
    }

    /// Unwinds a buy: the input goes to the destination wallet instead.
    pub fn buy_cancel(ctx: Context<BuyCancel>) -> Result<()> {
        buy::buy_cancel(ctx)
    }
}

// ---------------------------------------------------------------------------- state

#[account(zero_copy)]
#[repr(C)]
pub struct Pool {
    pub admin: Pubkey,
    pub next_index: u64,
    pub current_root_index: u64,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub zeros: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
    /// Listed assets not yet closed; the pool can only close at 0.
    pub asset_count: u64,
}

impl Pool {
    pub const SIZE: usize = 32 + 8 + 8 + 32 * LEVELS * 2 + 32 * ROOT_HISTORY + 8;

    pub(crate) fn is_known_root(&self, root: &[u8; 32]) -> bool {
        *root != [0u8; 32] && self.roots.iter().any(|r| r == root)
    }

    /// Inserts two leaves at next_index, next_index + 1. Returns the first index.
    pub(crate) fn insert(&mut self, leaf1: &[u8; 32], leaf2: &[u8; 32]) -> Result<u64> {
        let next = self.next_index;
        require!(next + 2 <= 1u64 << LEVELS, SolMixError::TreeFull);
        let mut index = next / 2;
        let mut hash = poseidon2(leaf1, leaf2)?;
        for i in 1..LEVELS {
            let (left, right) = if index % 2 == 0 {
                self.filled_subtrees[i] = hash;
                (hash, self.zeros[i])
            } else {
                (self.filled_subtrees[i], hash)
            };
            hash = poseidon2(&left, &right)?;
            index /= 2;
        }
        self.current_root_index = (self.current_root_index + 1) % ROOT_HISTORY as u64;
        self.roots[self.current_root_index as usize] = hash;
        self.next_index = next + 2;
        Ok(next)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Asset {
    /// Pubkey::default() for native SOL.
    pub mint: Pubkey,
    pub decimals: u8,
    pub paused: bool,
    pub bump: u8,
    #[max_len(MAX_DENOMINATIONS)]
    pub denominations: Vec<u64>,
    /// When deposits were last paused (unix seconds).
    pub paused_at: i64,
}

/// Exists only to mark a nullifier as spent; creating it twice fails.
#[account]
pub struct Nullifier {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransactArgs {
    pub proof: Vec<u8>,
    pub root: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub ext_amount: i64,
    pub fee: u64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
}

#[event]
pub struct TransactEvent {
    pub mint: Pubkey,
    pub first_index: u64,
    pub commitments: [[u8; 32]; 2],
    pub nullifiers: [[u8; 32]; 2],
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
    pub ext_amount: i64,
    pub fee: u64,
}

// ---------------------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Pool::SIZE, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddSolAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(init, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, NATIVE_SOL.as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddTokenAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
}

#[derive(Accounts)]
pub struct CloseAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump, close = admin)]
    pub asset: Account<'info, Asset>,
    #[account(seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    // Token assets only.
    #[account(mut)]
    pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
}

#[derive(Accounts)]
pub struct ClosePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump, close = admin, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump, constraint = pool.load()?.admin == admin.key() @ SolMixError::Unauthorized)]
    pub pool: AccountLoader<'info, Pool>,
}

#[derive(Accounts)]
#[instruction(args: TransactArgs)]
pub struct Transact<'info> {
    /// Pays fees and nullifier rent. The depositor for deposits; a relayer or anyone for withdrawals.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(init, payer = signer, space = 8, seeds = [NULLIFIER_SEED, args.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = signer, space = 8, seeds = [NULLIFIER_SEED, args.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    /// CHECK: bound into the proof via ext data. Receives withdrawals: a wallet for SOL, a token account otherwise.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: bound into the proof via ext data. Receives the relayer fee, same rules as `recipient`.
    #[account(mut)]
    pub relayer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    // Token assets only (pass the program id as a placeholder for SOL).
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)]
    pub vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Source of a token deposit, owned by `signer`.
    #[account(mut)]
    pub depositor_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------- value movement

fn check_token_accounts(a: &Transact, mint_key: &Pubkey) -> Result<()> {
    let mint = a.mint.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
    let vault = a.vault.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
    let token_program = a.token_program.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
    require_keys_eq!(mint.key(), *mint_key, SolMixError::WrongMint);
    let expected = get_associated_token_address_with_program_id(&a.pool.key(), mint_key, &token_program.key());
    require_keys_eq!(vault.key(), expected, SolMixError::WrongVault);
    Ok(())
}

fn deposit(a: &mut Transact, is_sol: bool, amount: u64) -> Result<()> {
    if is_sol {
        return system_program::transfer(
            CpiContext::new(
                a.system_program.to_account_info(),
                system_program::Transfer { from: a.signer.to_account_info(), to: a.sol_vault.to_account_info() },
            ),
            amount,
        );
    }
    let mint = a.mint.as_ref().unwrap();
    let from = a.depositor_token.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
    let token_program = a.token_program.as_ref().unwrap();
    let decimals = mint.decimals;
    let before = a.vault.as_ref().unwrap().amount;
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: a.vault.as_ref().unwrap().to_account_info(),
                authority: a.signer.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;
    // Notes are minted for `amount`, so the vault must receive exactly that (no transfer fees).
    let vault = a.vault.as_mut().unwrap();
    vault.reload()?;
    require!(vault.amount.checked_sub(before) == Some(amount), SolMixError::TransferFeeNotSupported);
    Ok(())
}

fn pay_out<'info>(
    a: &Transact<'info>,
    sol_vault_bump: u8,
    pool_bump: u8,
    is_sol: bool,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if is_sol {
        let seeds: &[&[u8]] = &[SOL_VAULT_SEED, &[sol_vault_bump]];
        return system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.to_account_info(),
                system_program::Transfer { from: a.sol_vault.to_account_info(), to },
                &[seeds],
            ),
            amount,
        );
    }
    let mint = a.mint.as_ref().unwrap();
    let seeds: &[&[u8]] = &[POOL_SEED, &[pool_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.as_ref().unwrap().to_account_info(),
            TransferChecked {
                from: a.vault.as_ref().unwrap().to_account_info(),
                mint: mint.to_account_info(),
                to,
                authority: a.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

// ---------------------------------------------------------------------------- crypto helpers

pub(crate) fn verify_proof(proof: &[u8], public_inputs: &[[u8; 32]; NR_PUBLIC_INPUTS]) -> Result<()> {
    let a: &[u8; 64] = proof[0..64].try_into().unwrap();
    let b: &[u8; 128] = proof[64..192].try_into().unwrap();
    let c: &[u8; 64] = proof[192..256].try_into().unwrap();
    let mut verifier =
        Groth16Verifier::new(a, b, c, public_inputs, &VERIFYINGKEY).map_err(|_| error!(SolMixError::InvalidProof))?;
    verifier.verify().map_err(|_| error!(SolMixError::InvalidProof))?;
    Ok(())
}

pub(crate) fn poseidon2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&left[..], &right[..]])
        .map(|h| h.to_bytes())
        .map_err(|_| error!(SolMixError::PoseidonFailed))
}

/// keccak256(recipient | ext_amount LE | relayer | fee LE | mint | enc1 | enc2) mod p
pub(crate) fn ext_data_hash(
    recipient: &Pubkey,
    ext_amount: i64,
    relayer: &Pubkey,
    fee: u64,
    mint: &Pubkey,
    enc1: &[u8],
    enc2: &[u8],
) -> [u8; 32] {
    let h = keccak::hashv(&[
        recipient.as_ref(),
        &ext_amount.to_le_bytes(),
        relayer.as_ref(),
        &fee.to_le_bytes(),
        mint.as_ref(),
        enc1,
        enc2,
    ]);
    reduce(h.to_bytes())
}

/// The circuit's asset id: the first 31 bytes of the mint, as a big-endian field element.
/// Native SOL (Pubkey::default) is 0.
pub(crate) fn asset_id(mint: &Pubkey) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&mint.to_bytes()[..31]);
    out
}

/// (ext_amount - fee) as a field element; negatives wrap to p - |x|.
pub(crate) fn public_amount(ext_amount: i64, fee: u64) -> [u8; 32] {
    let v = ext_amount as i128 - fee as i128;
    if v >= 0 {
        u128_be(v as u128)
    } else {
        sub_be(&FIELD_SIZE, &u128_be(v.unsigned_abs()))
    }
}

fn u128_be(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

/// a - b for big-endian 256-bit numbers, a >= b.
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut v = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if v < 0 {
            v += 256;
            1
        } else {
            0
        };
        out[i] = v as u8;
    }
    out
}

/// x mod p for a 256-bit x (p > 2^253, so at most 5 subtractions).
pub(crate) fn reduce(mut x: [u8; 32]) -> [u8; 32] {
    while x >= FIELD_SIZE {
        x = sub_be(&x, &FIELD_SIZE);
    }
    x
}

fn checked_denominations(mut d: Vec<u64>) -> Result<Vec<u64>> {
    require!(!d.is_empty() && d.len() <= MAX_DENOMINATIONS, SolMixError::InvalidDenomination);
    require!(d.iter().all(|&x| x > 0 && x <= i64::MAX as u64), SolMixError::InvalidDenomination);
    d.sort_unstable();
    d.dedup();
    Ok(d)
}

#[error_code]
pub enum SolMixError {
    #[msg("Only the pool admin can do this")]
    Unauthorized,
    #[msg("Proof is malformed or does not verify")]
    InvalidProof,
    #[msg("Encrypted outputs must be 68 bytes each")]
    InvalidEncryptedOutput,
    #[msg("Amount out of range")]
    InvalidAmount,
    #[msg("Both inputs use the same nullifier")]
    DuplicateNullifier,
    #[msg("Value is not a valid field element")]
    FieldOverflow,
    #[msg("Merkle root is not in the recent history")]
    UnknownRoot,
    #[msg("Deposits of this asset are paused")]
    DepositsPaused,
    #[msg("Amount is not an allowed deposit size for this asset")]
    InvalidDenomination,
    #[msg("Deposits cannot carry a relayer fee")]
    FeeOnDeposit,
    #[msg("Token assets need mint, vault and token program accounts")]
    MissingTokenAccounts,
    #[msg("Mint does not match the asset")]
    WrongMint,
    #[msg("Vault is not the pool's token account for this mint")]
    WrongVault,
    #[msg("Token charged a transfer fee; this asset is not supported")]
    TransferFeeNotSupported,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Poseidon hash failed")]
    PoseidonFailed,
    #[msg("Swap deadline has passed")]
    SwapExpired,
    #[msg("Cannot swap an asset for itself")]
    SwapSameAsset,
    #[msg("Swap order is not in the right state for this step")]
    SwapState,
    #[msg("Swap returned less than the minimum")]
    SwapUnderfilled,
    #[msg("Swap program is not the whitelisted aggregator")]
    WrongSwapProgram,
    #[msg("Swap route may not touch pool accounts")]
    ForbiddenRouteAccount,
    #[msg("Pause the asset and wait the close delay first")]
    CloseNotAllowed,
    #[msg("The vault still holds funds")]
    VaultNotEmpty,
    #[msg("Orders may stay open for at most an hour")]
    DeadlineTooFar,
    #[msg("This asset is paused")]
    AssetPaused,
}
