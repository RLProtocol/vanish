//! v2: shielded swaps (see docs/v2-shielded-swaps.md).
//!
//!   swap_prepare -> swap_commit_out -> swap_open -> swap_execute
//!                                          \-> swap_cancel (private refund)
//!
//! Every note the pool will ever create for a swap is proven before any value moves:
//! the refund notes (worth exactly the input) in swap_prepare and the output notes (worth
//! exactly min_out) in swap_commit_out. swap_open's proof then binds a hash of those terms,
//! so a relayer can neither substitute notes nor change the deal.
//!
//! The route itself is a CPI into the whitelisted aggregator signed only by the order PDA,
//! so it can only spend what sits in that order's escrow.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::AccountMeta, instruction::Instruction, keccak, program::invoke_signed};
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token::spl_token::native_mint;
use anchor_spl::token_interface::{self, CloseAccount, Mint, SyncNative, TokenAccount, TokenInterface, TransferChecked};

use crate::verifying_key::NR_PUBLIC_INPUTS;
use crate::{
    asset_id, ext_data_hash, public_amount, reduce, verify_proof, Asset, Nullifier, Pool, SolMixError, TransactArgs, TransactEvent,
    ASSET_SEED, ENCRYPTED_OUTPUT_LEN, FIELD_SIZE, NATIVE_SOL, NULLIFIER_SEED, POOL_SEED, PROOF_LEN, SOL_VAULT_SEED,
};

pub const ORDER_SEED: &[u8] = b"order";

/// Jupiter v6 aggregator. Tests build with `--features mock-swap` to target a local mock instead.
#[cfg(not(feature = "mock-swap"))]
pub const SWAP_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
#[cfg(feature = "mock-swap")]
pub const SWAP_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!("9rX8mRUjYP6yugEcM9DtzZriTDaRheNQuPHQeSk4f1uB");

/// One swap. Seeded by a random id chosen by the user's client.
#[account]
#[derive(InitSpace)]
pub struct SwapOrder {
    pub relayer: Pubkey,
    pub order_id: [u8; 32],
    pub bump: u8,
    pub mint_in: Pubkey,
    pub amount_in: u64,
    pub deadline: i64,
    pub refund_commitments: [[u8; 32]; 2],
    #[max_len(ENCRYPTED_OUTPUT_LEN)]
    pub refund_encrypted1: Vec<u8>,
    #[max_len(ENCRYPTED_OUTPUT_LEN)]
    pub refund_encrypted2: Vec<u8>,
    pub out_ready: bool,
    pub mint_out: Pubkey,
    pub min_out: u64,
    pub out_commitments: [[u8; 32]; 2],
    #[max_len(ENCRYPTED_OUTPUT_LEN)]
    pub out_encrypted1: Vec<u8>,
    #[max_len(ENCRYPTED_OUTPUT_LEN)]
    pub out_encrypted2: Vec<u8>,
    /// swap_open ran: amount_in sits in the escrow.
    pub opened: bool,
}

impl SwapOrder {
    /// keccak("swap" | mint_out | min_out | deadline | out cms | out encs | refund cms | refund encs).
    /// swap_open's proof commits to this, which pins every note the order can create.
    pub fn terms_hash(&self) -> [u8; 32] {
        keccak::hashv(&[
            b"swap",
            self.mint_out.as_ref(),
            &self.min_out.to_le_bytes(),
            &self.deadline.to_le_bytes(),
            &self.out_commitments[0],
            &self.out_commitments[1],
            &self.out_encrypted1,
            &self.out_encrypted2,
            &self.refund_commitments[0],
            &self.refund_commitments[1],
            &self.refund_encrypted1,
            &self.refund_encrypted2,
        ])
        .to_bytes()
    }
}

/// keccak(order | ext_amount | relayer | fee | mint_in | enc1 | enc2 | terms_hash) mod p
#[allow(clippy::too_many_arguments)]
pub fn swap_ext_data_hash(
    order: &Pubkey,
    ext_amount: i64,
    relayer: &Pubkey,
    fee: u64,
    mint_in: &Pubkey,
    enc1: &[u8],
    enc2: &[u8],
    terms_hash: &[u8; 32],
) -> [u8; 32] {
    let h = keccak::hashv(&[
        order.as_ref(),
        &ext_amount.to_le_bytes(),
        relayer.as_ref(),
        &fee.to_le_bytes(),
        mint_in.as_ref(),
        enc1,
        enc2,
        terms_hash,
    ]);
    reduce(h.to_bytes())
}

pub(crate) fn check_tx_shape(tx: &TransactArgs) -> Result<()> {
    require!(tx.proof.len() == PROOF_LEN, SolMixError::InvalidProof);
    require!(
        tx.encrypted_output1.len() == ENCRYPTED_OUTPUT_LEN && tx.encrypted_output2.len() == ENCRYPTED_OUTPUT_LEN,
        SolMixError::InvalidEncryptedOutput
    );
    require!(tx.ext_amount != i64::MIN && tx.fee <= i64::MAX as u64, SolMixError::InvalidAmount);
    require!(tx.input_nullifiers[0] != tx.input_nullifiers[1], SolMixError::DuplicateNullifier);
    for x in tx.input_nullifiers.iter().chain(tx.output_commitments.iter()) {
        require!(*x < FIELD_SIZE, SolMixError::FieldOverflow);
    }
    Ok(())
}

pub(crate) fn verify(pool: &AccountLoader<Pool>, tx: &TransactArgs, ext_hash: [u8; 32], mint: &Pubkey) -> Result<()> {
    require!(pool.load()?.is_known_root(&tx.root), SolMixError::UnknownRoot);
    let inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        tx.root,
        public_amount(tx.ext_amount, tx.fee),
        ext_hash,
        asset_id(mint),
        tx.input_nullifiers[0],
        tx.input_nullifiers[1],
        tx.output_commitments[0],
        tx.output_commitments[1],
    ];
    verify_proof(&tx.proof, &inputs)
}

/// A proof shaped like a deposit of exactly `ext_amount` into the order (no fee): it proves the
/// two output notes are worth that much in total, without moving any value.
fn verify_deposit_shaped(pool: &AccountLoader<Pool>, tx: &TransactArgs, order: &Pubkey, mint: &Pubkey) -> Result<()> {
    check_tx_shape(tx)?;
    require!(tx.ext_amount > 0 && tx.fee == 0, SolMixError::InvalidAmount);
    let ext_hash = ext_data_hash(order, tx.ext_amount, order, 0, mint, &tx.encrypted_output1, &tx.encrypted_output2);
    verify(pool, tx, ext_hash, mint)
}

/// The token mint an escrow holds: the asset's mint, or wrapped SOL for native SOL.
pub fn escrow_mint_for(asset_mint: &Pubkey) -> Pubkey {
    if *asset_mint == NATIVE_SOL {
        native_mint::ID
    } else {
        *asset_mint
    }
}

fn check_vault(vault: &Option<Box<InterfaceAccount<TokenAccount>>>, pool: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Result<()> {
    let vault = vault.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
    let expected = get_associated_token_address_with_program_id(pool, mint, token_program);
    require_keys_eq!(vault.key(), expected, SolMixError::WrongVault);
    Ok(())
}

// ---------------------------------------------------------------------------- swap_prepare

#[derive(Accounts)]
#[instruction(order_id: [u8; 32], deadline: i64, refund: TransactArgs)]
pub struct SwapPrepare<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(seeds = [ASSET_SEED, asset_in.mint.as_ref()], bump = asset_in.bump)]
    pub asset_in: Box<Account<'info, Asset>>,
    #[account(init, payer = relayer, space = 8 + SwapOrder::INIT_SPACE, seeds = [ORDER_SEED, order_id.as_ref()], bump)]
    pub order: Box<Account<'info, SwapOrder>>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, refund.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, refund.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    pub system_program: Program<'info, System>,
}

/// Creates the order and proves its refund notes: worth exactly the amount that swap_open will
/// take out of the pool, in the same asset. Nothing moves yet.
pub fn swap_prepare(ctx: Context<SwapPrepare>, order_id: [u8; 32], deadline: i64, refund: TransactArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, SolMixError::SwapExpired);
    require!(deadline <= now + crate::MAX_ORDER_SECS, SolMixError::DeadlineTooFar);
    require!(!ctx.accounts.asset_in.paused, SolMixError::AssetPaused);
    let mint_in = ctx.accounts.asset_in.mint;
    verify_deposit_shaped(&ctx.accounts.pool, &refund, &ctx.accounts.order.key(), &mint_in)?;

    let order = &mut ctx.accounts.order;
    order.relayer = ctx.accounts.relayer.key();
    order.order_id = order_id;
    order.bump = ctx.bumps.order;
    order.mint_in = mint_in;
    order.amount_in = refund.ext_amount as u64;
    order.deadline = deadline;
    order.refund_commitments = refund.output_commitments;
    order.refund_encrypted1 = refund.encrypted_output1;
    order.refund_encrypted2 = refund.encrypted_output2;
    Ok(())
}

// ---------------------------------------------------------------------------- swap_commit_out

#[derive(Accounts)]
#[instruction(out: TransactArgs)]
pub struct SwapCommitOut<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(seeds = [ASSET_SEED, asset_out.mint.as_ref()], bump = asset_out.bump)]
    pub asset_out: Box<Account<'info, Asset>>,
    #[account(
        mut,
        has_one = relayer @ SolMixError::Unauthorized,
        constraint = !order.out_ready && !order.opened @ SolMixError::SwapState,
        constraint = order.mint_in != asset_out.mint @ SolMixError::SwapSameAsset,
    )]
    pub order: Box<Account<'info, SwapOrder>>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, out.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, out.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    #[account(address = escrow_mint_for(&asset_out.mint) @ SolMixError::WrongMint, mint::token_program = token_program_out)]
    pub escrow_mint_out: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = relayer,
        associated_token::mint = escrow_mint_out,
        associated_token::authority = order,
        associated_token::token_program = token_program_out,
    )]
    pub escrow_out: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program_out: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Proves the output notes: worth exactly min_out of the asset being bought.
pub fn swap_commit_out(ctx: Context<SwapCommitOut>, out: TransactArgs) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= ctx.accounts.order.deadline, SolMixError::SwapExpired);
    require!(!ctx.accounts.asset_out.paused, SolMixError::DepositsPaused);
    let mint_out = ctx.accounts.asset_out.mint;
    verify_deposit_shaped(&ctx.accounts.pool, &out, &ctx.accounts.order.key(), &mint_out)?;

    let order = &mut ctx.accounts.order;
    order.mint_out = mint_out;
    order.min_out = out.ext_amount as u64;
    order.out_commitments = out.output_commitments;
    order.out_encrypted1 = out.encrypted_output1;
    order.out_encrypted2 = out.encrypted_output2;
    order.out_ready = true;
    Ok(())
}

// ---------------------------------------------------------------------------- swap_open

#[derive(Accounts)]
#[instruction(tx: TransactArgs)]
pub struct SwapOpen<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(
        mut,
        has_one = relayer @ SolMixError::Unauthorized,
        constraint = order.out_ready && !order.opened @ SolMixError::SwapState,
    )]
    pub order: Box<Account<'info, SwapOrder>>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, tx.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, tx.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    /// CHECK: bound into the proof; receives the relayer fee in the input asset (wallet for SOL, token account otherwise).
    #[account(mut)]
    pub relayer_fee_account: UncheckedAccount<'info>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(address = escrow_mint_for(&order.mint_in) @ SolMixError::WrongMint, mint::token_program = token_program_in)]
    pub escrow_mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = relayer,
        associated_token::mint = escrow_mint_in,
        associated_token::authority = order,
        associated_token::token_program = token_program_in,
    )]
    pub escrow_in: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Pool vault for the input asset (token assets only).
    #[account(mut)]
    pub vault_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Spends the user's notes: amount_in moves from the pool into the order's escrow, the relayer
/// fee is paid, and the user's change notes are inserted.
pub fn swap_open<'info>(ctx: Context<'_, '_, '_, 'info, SwapOpen<'info>>, tx: TransactArgs) -> Result<()> {
    check_tx_shape(&tx)?;
    let order = &ctx.accounts.order;
    require!(Clock::get()?.unix_timestamp <= order.deadline, SolMixError::SwapExpired);
    require!(tx.ext_amount < 0 && tx.ext_amount.unsigned_abs() == order.amount_in, SolMixError::InvalidAmount);
    let mint_in = order.mint_in;
    let amount_in = order.amount_in;

    let ext_hash = swap_ext_data_hash(
        &order.key(),
        tx.ext_amount,
        &ctx.accounts.relayer_fee_account.key(),
        tx.fee,
        &mint_in,
        &tx.encrypted_output1,
        &tx.encrypted_output2,
        &order.terms_hash(),
    );
    verify(&ctx.accounts.pool, &tx, ext_hash, &mint_in)?;

    let a = &ctx.accounts;
    if mint_in == NATIVE_SOL {
        let seeds: &[&[u8]] = &[SOL_VAULT_SEED, &[ctx.bumps.sol_vault]];
        let pay = |to: AccountInfo<'info>, amount: u64| {
            system_program::transfer(
                CpiContext::new_with_signer(
                    a.system_program.to_account_info(),
                    system_program::Transfer { from: a.sol_vault.to_account_info(), to },
                    &[seeds],
                ),
                amount,
            )
        };
        pay(a.escrow_in.to_account_info(), amount_in)?;
        token_interface::sync_native(CpiContext::new(a.token_program_in.to_account_info(), SyncNative { account: a.escrow_in.to_account_info() }))?;
        if tx.fee > 0 {
            pay(a.relayer_fee_account.to_account_info(), tx.fee)?;
        }
    } else {
        check_vault(&a.vault_in, &a.pool.key(), &mint_in, &a.token_program_in.key())?;
        let vault = a.vault_in.as_ref().unwrap();
        let seeds: &[&[u8]] = &[POOL_SEED, &[ctx.bumps.pool]];
        let pay = |to: AccountInfo<'info>, amount: u64| {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program_in.to_account_info(),
                    TransferChecked {
                        from: vault.to_account_info(),
                        mint: a.escrow_mint_in.to_account_info(),
                        to,
                        authority: a.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                a.escrow_mint_in.decimals,
            )
        };
        pay(a.escrow_in.to_account_info(), amount_in)?;
        if tx.fee > 0 {
            pay(a.relayer_fee_account.to_account_info(), tx.fee)?;
        }
    }

    let first_index = ctx.accounts.pool.load_mut()?.insert(&tx.output_commitments[0], &tx.output_commitments[1])?;
    emit!(TransactEvent {
        mint: mint_in,
        first_index,
        commitments: tx.output_commitments,
        nullifiers: tx.input_nullifiers,
        encrypted_output1: tx.encrypted_output1,
        encrypted_output2: tx.encrypted_output2,
        ext_amount: tx.ext_amount,
        fee: tx.fee,
    });
    ctx.accounts.order.opened = true;
    Ok(())
}

// ---------------------------------------------------------------------------- swap_execute

#[derive(Accounts)]
pub struct SwapExecute<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, has_one = relayer @ SolMixError::Unauthorized, constraint = order.opened @ SolMixError::SwapState, close = relayer)]
    pub order: Box<Account<'info, SwapOrder>>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(address = escrow_mint_for(&order.mint_in) @ SolMixError::WrongMint)]
    pub escrow_mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = escrow_mint_for(&order.mint_out) @ SolMixError::WrongMint)]
    pub escrow_mint_out: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = escrow_mint_in, associated_token::authority = order, associated_token::token_program = token_program_in)]
    pub escrow_in: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = escrow_mint_out, associated_token::authority = order, associated_token::token_program = token_program_out)]
    pub escrow_out: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Pool vault for the input asset (token assets only): receives whatever the route didn't spend.
    #[account(mut)]
    pub vault_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Pool vault for the output asset (token assets only): receives min_out.
    #[account(mut)]
    pub vault_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: receives positive slippage when buying a token: the relayer's token account for that mint.
    /// When buying SOL the surplus reaches the relayer through the order's close instead.
    #[account(mut)]
    pub relayer_out_account: UncheckedAccount<'info>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
    /// CHECK: the whitelisted aggregator
    #[account(address = SWAP_PROGRAM_ID @ SolMixError::WrongSwapProgram)]
    pub swap_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Runs the route (accounts in remaining_accounts, instruction data in `route_data`), then
/// requires at least min_out in the output escrow. min_out goes into the pool and the output
/// notes are inserted; any surplus is the relayer's tip; unspent input goes back to the pool.
pub fn swap_execute<'info>(ctx: Context<'_, '_, 'info, 'info, SwapExecute<'info>>, route_data: Vec<u8>) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= ctx.accounts.order.deadline, SolMixError::SwapExpired);
    let order_key = ctx.accounts.order.key();
    let pool_key = ctx.accounts.pool.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();

    // Only the order PDA signs the route. The pool and the SOL vault may not even appear in it.
    let mut metas = Vec::with_capacity(ctx.remaining_accounts.len());
    for acc in ctx.remaining_accounts.iter() {
        require!(*acc.key != pool_key && *acc.key != sol_vault_key, SolMixError::ForbiddenRouteAccount);
        metas.push(AccountMeta { pubkey: *acc.key, is_signer: *acc.key == order_key, is_writable: acc.is_writable });
    }
    let mut infos = ctx.remaining_accounts.to_vec();
    infos.push(ctx.accounts.order.to_account_info());
    infos.push(ctx.accounts.swap_program.to_account_info());

    let out_before = ctx.accounts.escrow_out.amount;
    let order_id = ctx.accounts.order.order_id;
    let bump = [ctx.accounts.order.bump];
    let signer: &[&[u8]] = &[ORDER_SEED, &order_id, &bump];
    invoke_signed(&Instruction { program_id: SWAP_PROGRAM_ID, accounts: metas, data: route_data }, &infos, &[signer])?;

    let a = &mut *ctx.accounts;
    a.escrow_out.reload()?;
    a.escrow_in.reload()?;
    let received = a.escrow_out.amount.saturating_sub(out_before);
    let min_out = a.order.min_out;
    require!(received >= min_out, SolMixError::SwapUnderfilled);
    let mint_in = a.order.mint_in;
    let mint_out = a.order.mint_out;
    let order_info = a.order.to_account_info();
    let relayer_info = a.relayer.to_account_info();
    // SOL owed to the pool. Unwrapped wSOL lands on the order and is moved to the SOL vault
    // directly, after the last CPI (the runtime rejects CPIs after a direct lamport move).
    let mut to_sol_vault = 0u64;

    // output: min_out into the pool, the rest to the relayer
    if mint_out == NATIVE_SOL {
        // The surplus and the escrow rent reach the relayer when the order closes.
        close_escrow(&a.token_program_out, &a.escrow_out, &order_info, &order_info, signer)?;
        to_sol_vault += min_out;
    } else {
        check_vault(&a.vault_out, &pool_key, &mint_out, &a.token_program_out.key())?;
        let vault = a.vault_out.as_mut().unwrap();
        let before = vault.amount;
        escrow_pay(&a.token_program_out, &a.escrow_out, &a.escrow_mint_out, vault.to_account_info(), &order_info, signer, min_out)?;
        vault.reload()?;
        // the notes are worth min_out, so the vault must receive exactly that
        require!(vault.amount.checked_sub(before) == Some(min_out), SolMixError::TransferFeeNotSupported);
        let surplus = a.escrow_out.amount - min_out;
        escrow_pay(&a.token_program_out, &a.escrow_out, &a.escrow_mint_out, a.relayer_out_account.to_account_info(), &order_info, signer, surplus)?;
        close_escrow(&a.token_program_out, &a.escrow_out, &relayer_info, &order_info, signer)?;
    }

    // input: whatever the route didn't spend goes back to the pool
    let leftover_in = a.escrow_in.amount;
    if mint_in == NATIVE_SOL {
        close_escrow(&a.token_program_in, &a.escrow_in, &order_info, &order_info, signer)?;
        to_sol_vault += leftover_in;
    } else {
        if leftover_in > 0 {
            check_vault(&a.vault_in, &pool_key, &mint_in, &a.token_program_in.key())?;
            let vault = a.vault_in.as_ref().unwrap();
            escrow_pay(&a.token_program_in, &a.escrow_in, &a.escrow_mint_in, vault.to_account_info(), &order_info, signer, leftover_in)?;
        }
        close_escrow(&a.token_program_in, &a.escrow_in, &relayer_info, &order_info, signer)?;
    }
    move_lamports(&order_info, &a.sol_vault.to_account_info(), to_sol_vault)?;

    let order = &a.order;
    let first_index = a.pool.load_mut()?.insert(&order.out_commitments[0], &order.out_commitments[1])?;
    emit!(TransactEvent {
        mint: mint_out,
        first_index,
        commitments: order.out_commitments,
        nullifiers: [[0u8; 32]; 2],
        encrypted_output1: order.out_encrypted1.clone(),
        encrypted_output2: order.out_encrypted2.clone(),
        ext_amount: min_out as i64,
        fee: 0,
    });
    Ok(())
}

// ---------------------------------------------------------------------------- swap_cancel

#[derive(Accounts)]
pub struct SwapCancel<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, close = relayer)]
    pub order: Box<Account<'info, SwapOrder>>,
    /// CHECK: rent goes back to whoever created the order
    #[account(mut, address = order.relayer @ SolMixError::Unauthorized)]
    pub relayer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    // Needed once swap_open has run.
    pub escrow_mint_in: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)]
    pub escrow_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub vault_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program_in: Option<Interface<'info, TokenInterface>>,
    // Needed once swap_commit_out has run.
    #[account(mut)]
    pub escrow_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program_out: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}

/// The relayer can cancel any time before execution; anyone can after the deadline, so funds
/// never depend on the relayer showing up. If swap_open ran, the escrow goes back to the pool
/// and the proven refund notes are inserted.
pub fn swap_cancel(ctx: Context<SwapCancel>) -> Result<()> {
    let a = &ctx.accounts;
    let order = &a.order;
    let now = Clock::get()?.unix_timestamp;
    require!(a.caller.key() == order.relayer || now > order.deadline, SolMixError::Unauthorized);
    let bump = [order.bump];
    let signer: &[&[u8]] = &[ORDER_SEED, &order.order_id, &bump];
    let order_info = order.to_account_info();
    let relayer_info = a.relayer.to_account_info();
    let order_key = order.key();

    if order.out_ready {
        let escrow_out = a.escrow_out.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let tp = a.token_program_out.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let expected = get_associated_token_address_with_program_id(&order_key, &escrow_mint_for(&order.mint_out), &tp.key());
        require_keys_eq!(escrow_out.key(), expected, SolMixError::WrongVault);
        // Anyone can send tokens to the escrow, and a token account holding a balance can't
        // close. That must not block the refund, so a non-empty one is left behind (wSOL always closes).
        if escrow_out.amount == 0 || escrow_out.is_native() {
            close_escrow(tp, escrow_out, &relayer_info, &order_info, signer)?;
        }
    }

    if order.opened {
        let mint = a.escrow_mint_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let escrow_in = a.escrow_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let tp = a.token_program_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        require_keys_eq!(mint.key(), escrow_mint_for(&order.mint_in), SolMixError::WrongMint);
        let expected = get_associated_token_address_with_program_id(&order_key, &mint.key(), &tp.key());
        require_keys_eq!(escrow_in.key(), expected, SolMixError::WrongVault);
        let held = escrow_in.amount;

        if order.mint_in == NATIVE_SOL {
            close_escrow(tp, escrow_in, &order_info, &order_info, signer)?;
            move_lamports(&order_info, &a.sol_vault.to_account_info(), held)?;
        } else {
            check_vault(&a.vault_in, &a.pool.key(), &order.mint_in, &tp.key())?;
            let vault = a.vault_in.as_ref().unwrap();
            escrow_pay(tp, escrow_in, mint, vault.to_account_info(), &order_info, signer, held)?;
            close_escrow(tp, escrow_in, &relayer_info, &order_info, signer)?;
        }

        let first_index = a.pool.load_mut()?.insert(&order.refund_commitments[0], &order.refund_commitments[1])?;
        emit!(TransactEvent {
            mint: order.mint_in,
            first_index,
            commitments: order.refund_commitments,
            nullifiers: [[0u8; 32]; 2],
            encrypted_output1: order.refund_encrypted1.clone(),
            encrypted_output2: order.refund_encrypted2.clone(),
            ext_amount: 0,
            fee: 0,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------- helpers

pub(crate) fn escrow_pay<'info>(
    token_program: &Interface<'info, TokenInterface>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    order: &AccountInfo<'info>,
    signer: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked { from: escrow.to_account_info(), mint: mint.to_account_info(), to, authority: order.clone() },
            &[signer],
        ),
        amount,
        mint.decimals,
    )
}

pub(crate) fn close_escrow<'info>(
    token_program: &Interface<'info, TokenInterface>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    destination: &AccountInfo<'info>,
    order: &AccountInfo<'info>,
    signer: &[&[u8]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount { account: escrow.to_account_info(), destination: destination.clone(), authority: order.clone() },
        &[signer],
    ))
}

/// Debits the order PDA (owned by this program) directly.
pub(crate) fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(amount).ok_or(SolMixError::InvalidAmount)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(SolMixError::InvalidAmount)?;
    Ok(())
}
