//! v2: private buy. Spend shielded notes on any token the aggregator can route (pump.fun,
//! PumpSwap, Raydium, ...) and deliver it straight to a fresh wallet. The token is never
//! listed or held by the pool.
//!
//!   buy_open    proof spends the input notes; amount_in -> the order's escrow, fee -> relayer
//!   buy_execute route signed only by the order PDA; >= min_out must land in the destination
//!   buy_cancel  the input (and gas) goes to the destination wallet instead, as a plain withdrawal
//!
//! The proof binds the order, the output mint, min_out, the deadline, the destination and the
//! gas amount, so the relayer can't redirect or reprice the buy.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::AccountMeta, instruction::Instruction, keccak, program::invoke_signed};
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::{self, Mint, SyncNative, TokenAccount, TokenInterface, TransferChecked};

use crate::swap::{check_tx_shape, close_escrow, escrow_mint_for, escrow_pay, move_lamports, swap_ext_data_hash, verify, SWAP_PROGRAM_ID};
use crate::{Asset, Nullifier, Pool, SolMixError, TransactArgs, TransactEvent, ASSET_SEED, NATIVE_SOL, NULLIFIER_SEED, POOL_SEED, SOL_VAULT_SEED};

pub const BUY_SEED: &[u8] = b"buy";
/// 0.001 SOL: above the rent-exempt minimum of an empty wallet.
pub const MIN_GAS: u64 = 1_000_000;

#[account]
#[derive(InitSpace)]
pub struct BuyOrder {
    pub relayer: Pubkey,
    pub order_id: [u8; 32],
    pub bump: u8,
    pub mint_in: Pubkey,
    pub amount_in: u64,
    /// Extra lamports (SOL input only) handed to the destination so it can pay fees later.
    pub gas: u64,
    pub mint_out: Pubkey,
    pub min_out: u64,
    pub deadline: i64,
    pub destination: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BuyTerms {
    pub mint_out: Pubkey,
    pub min_out: u64,
    pub deadline: i64,
    pub destination: Pubkey,
    pub gas: u64,
}

impl BuyTerms {
    /// keccak("buy" | mint_out | min_out | deadline | destination | gas)
    pub fn hash(&self) -> [u8; 32] {
        keccak::hashv(&[
            b"buy",
            self.mint_out.as_ref(),
            &self.min_out.to_le_bytes(),
            &self.deadline.to_le_bytes(),
            self.destination.as_ref(),
            &self.gas.to_le_bytes(),
        ])
        .to_bytes()
    }
}

// ---------------------------------------------------------------------------- buy_open

#[derive(Accounts)]
#[instruction(order_id: [u8; 32], terms: BuyTerms, tx: TransactArgs)]
pub struct BuyOpen<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(seeds = [ASSET_SEED, asset_in.mint.as_ref()], bump = asset_in.bump)]
    pub asset_in: Box<Account<'info, Asset>>,
    #[account(init, payer = relayer, space = 8 + BuyOrder::INIT_SPACE, seeds = [BUY_SEED, order_id.as_ref()], bump)]
    pub order: Box<Account<'info, BuyOrder>>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, tx.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = relayer, space = 8, seeds = [NULLIFIER_SEED, tx.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    /// CHECK: bound into the proof; receives the relayer fee (wallet for SOL, token account otherwise).
    #[account(mut)]
    pub relayer_fee_account: UncheckedAccount<'info>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(address = escrow_mint_for(&asset_in.mint) @ SolMixError::WrongMint, mint::token_program = token_program_in)]
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

/// ext_amount = -(amount_in + gas). amount_in goes to the escrow; gas waits on the order account.
pub fn buy_open<'info>(ctx: Context<'_, '_, '_, 'info, BuyOpen<'info>>, order_id: [u8; 32], terms: BuyTerms, tx: TransactArgs) -> Result<()> {
    check_tx_shape(&tx)?;
    let now = Clock::get()?.unix_timestamp;
    require!(terms.deadline > now, SolMixError::SwapExpired);
    require!(terms.deadline <= now + crate::MAX_ORDER_SECS, SolMixError::DeadlineTooFar);
    require!(!ctx.accounts.asset_in.paused, SolMixError::AssetPaused);
    require!(terms.min_out > 0 && tx.ext_amount < 0, SolMixError::InvalidAmount);
    let mint_in = ctx.accounts.asset_in.mint;
    require_keys_neq!(terms.mint_out, mint_in, SolMixError::SwapSameAsset);
    // gas only from SOL, and enough for a fresh wallet to exist (rent-exempt minimum)
    require!(terms.gas == 0 || (mint_in == NATIVE_SOL && terms.gas >= MIN_GAS), SolMixError::InvalidAmount);
    let total = tx.ext_amount.unsigned_abs();
    let amount_in = total.checked_sub(terms.gas).filter(|x| *x > 0).ok_or(SolMixError::InvalidAmount)?;

    let ext_hash = swap_ext_data_hash(
        &ctx.accounts.order.key(),
        tx.ext_amount,
        &ctx.accounts.relayer_fee_account.key(),
        tx.fee,
        &mint_in,
        &tx.encrypted_output1,
        &tx.encrypted_output2,
        &terms.hash(),
    );
    verify(&ctx.accounts.pool, &tx, ext_hash, &mint_in)?;

    let a = &ctx.accounts;
    if mint_in == NATIVE_SOL {
        let seeds: &[&[u8]] = &[SOL_VAULT_SEED, &[ctx.bumps.sol_vault]];
        let pay = |to: AccountInfo<'info>, amount: u64| {
            if amount == 0 {
                return Ok(());
            }
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
        pay(a.order.to_account_info(), terms.gas)?;
        pay(a.relayer_fee_account.to_account_info(), tx.fee)?;
    } else {
        let vault = a.vault_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let expected = get_associated_token_address_with_program_id(&a.pool.key(), &mint_in, &a.token_program_in.key());
        require_keys_eq!(vault.key(), expected, SolMixError::WrongVault);
        let seeds: &[&[u8]] = &[POOL_SEED, &[ctx.bumps.pool]];
        let pay = |to: AccountInfo<'info>, amount: u64| {
            if amount == 0 {
                return Ok(());
            }
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
        pay(a.relayer_fee_account.to_account_info(), tx.fee)?;
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

    let order = &mut ctx.accounts.order;
    order.relayer = ctx.accounts.relayer.key();
    order.order_id = order_id;
    order.bump = ctx.bumps.order;
    order.mint_in = mint_in;
    order.amount_in = amount_in;
    order.gas = terms.gas;
    order.mint_out = terms.mint_out;
    order.min_out = terms.min_out;
    order.deadline = terms.deadline;
    order.destination = terms.destination;
    Ok(())
}

// ---------------------------------------------------------------------------- buy_execute

#[derive(Accounts)]
pub struct BuyExecute<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, has_one = relayer @ SolMixError::Unauthorized, has_one = destination @ SolMixError::WrongVault, close = relayer)]
    pub order: Box<Account<'info, BuyOrder>>,
    #[account(mut, seeds = [SOL_VAULT_SEED], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(address = escrow_mint_for(&order.mint_in) @ SolMixError::WrongMint)]
    pub escrow_mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = escrow_mint_in, associated_token::authority = order, associated_token::token_program = token_program_in)]
    pub escrow_in: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Pool vault for the input asset (token assets only): receives whatever the route didn't spend.
    #[account(mut)]
    pub vault_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: the wallet bound in the proof
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(address = order.mint_out @ SolMixError::WrongMint, mint::token_program = token_program_out)]
    pub mint_out: Box<InterfaceAccount<'info, Mint>>,
    /// The destination's token account for the bought token (create it idempotently beforehand).
    #[account(mut, associated_token::mint = mint_out, associated_token::authority = destination, associated_token::token_program = token_program_out)]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The order's own account for the bought token, when the route references it. Anything the
    /// route leaves there is swept to the destination, then it is closed (rent to the relayer).
    #[account(mut, associated_token::mint = mint_out, associated_token::authority = order, associated_token::token_program = token_program_out)]
    pub order_token_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
    /// CHECK: the whitelisted aggregator
    #[account(address = SWAP_PROGRAM_ID @ SolMixError::WrongSwapProgram)]
    pub swap_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Runs the route; at least min_out of the token must arrive in the destination's account.
/// Unspent input returns to the pool; gas goes to the destination.
pub fn buy_execute<'info>(ctx: Context<'_, '_, 'info, 'info, BuyExecute<'info>>, route_data: Vec<u8>) -> Result<()> {
    require!(Clock::get()?.unix_timestamp <= ctx.accounts.order.deadline, SolMixError::SwapExpired);
    let order_key = ctx.accounts.order.key();
    let pool_key = ctx.accounts.pool.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();

    let mut metas = Vec::with_capacity(ctx.remaining_accounts.len());
    for acc in ctx.remaining_accounts.iter() {
        require!(*acc.key != pool_key && *acc.key != sol_vault_key, SolMixError::ForbiddenRouteAccount);
        metas.push(AccountMeta { pubkey: *acc.key, is_signer: *acc.key == order_key, is_writable: acc.is_writable });
    }
    let mut infos = ctx.remaining_accounts.to_vec();
    infos.push(ctx.accounts.order.to_account_info());
    infos.push(ctx.accounts.swap_program.to_account_info());

    let out_before = ctx.accounts.destination_token.amount;
    let order_id = ctx.accounts.order.order_id;
    let bump = [ctx.accounts.order.bump];
    let signer: &[&[u8]] = &[BUY_SEED, &order_id, &bump];
    invoke_signed(&Instruction { program_id: SWAP_PROGRAM_ID, accounts: metas, data: route_data }, &infos, &[signer])?;

    let a = &mut *ctx.accounts;
    let order_info = a.order.to_account_info();
    let relayer_info = a.relayer.to_account_info();
    if let Some(parked) = a.order_token_out.as_mut() {
        parked.reload()?;
        escrow_pay(&a.token_program_out, parked, &a.mint_out, a.destination_token.to_account_info(), &order_info, signer, parked.amount)?;
        close_escrow(&a.token_program_out, parked, &relayer_info, &order_info, signer)?;
    }
    a.destination_token.reload()?;
    a.escrow_in.reload()?;
    let received = a.destination_token.amount.saturating_sub(out_before);
    require!(received >= a.order.min_out, SolMixError::SwapUnderfilled);

    let leftover_in = a.escrow_in.amount;
    let mut to_sol_vault = 0u64;
    if a.order.mint_in == NATIVE_SOL {
        close_escrow(&a.token_program_in, &a.escrow_in, &order_info, &order_info, signer)?;
        to_sol_vault = leftover_in;
    } else {
        if leftover_in > 0 {
            let vault = a.vault_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
            let expected = get_associated_token_address_with_program_id(&pool_key, &a.order.mint_in, &a.token_program_in.key());
            require_keys_eq!(vault.key(), expected, SolMixError::WrongVault);
            escrow_pay(&a.token_program_in, &a.escrow_in, &a.escrow_mint_in, vault.to_account_info(), &order_info, signer, leftover_in)?;
        }
        close_escrow(&a.token_program_in, &a.escrow_in, &relayer_info, &order_info, signer)?;
    }
    // direct lamport moves only after the last CPI
    move_lamports(&order_info, &a.sol_vault.to_account_info(), to_sol_vault)?;
    move_lamports(&order_info, &a.destination.to_account_info(), a.order.gas)?;
    Ok(())
}

// ---------------------------------------------------------------------------- buy_cancel

#[derive(Accounts)]
pub struct BuyCancel<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = destination @ SolMixError::WrongVault, close = relayer)]
    pub order: Box<Account<'info, BuyOrder>>,
    /// CHECK: rent goes back to whoever opened the order
    #[account(mut, address = order.relayer @ SolMixError::Unauthorized)]
    pub relayer: UncheckedAccount<'info>,
    /// CHECK: the wallet bound in the proof
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(address = escrow_mint_for(&order.mint_in) @ SolMixError::WrongMint)]
    pub escrow_mint_in: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = escrow_mint_in, associated_token::authority = order, associated_token::token_program = token_program_in)]
    pub escrow_in: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Token input only: the destination's account for the input asset (create it idempotently beforehand).
    #[account(mut)]
    pub destination_token_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// The relayer can cancel any time; anyone after the deadline. Whatever the order holds goes
/// to the destination wallet, exactly like a withdrawal to it.
pub fn buy_cancel(ctx: Context<BuyCancel>) -> Result<()> {
    let a = &ctx.accounts;
    let order = &a.order;
    require!(a.caller.key() == order.relayer || Clock::get()?.unix_timestamp > order.deadline, SolMixError::Unauthorized);
    let bump = [order.bump];
    let signer: &[&[u8]] = &[BUY_SEED, &order.order_id, &bump];
    let order_info = order.to_account_info();
    let held = a.escrow_in.amount;

    if order.mint_in == NATIVE_SOL {
        close_escrow(&a.token_program_in, &a.escrow_in, &order_info, &order_info, signer)?;
        move_lamports(&order_info, &a.destination.to_account_info(), held + order.gas)?;
    } else {
        let to = a.destination_token_in.as_ref().ok_or(SolMixError::MissingTokenAccounts)?;
        let expected = get_associated_token_address_with_program_id(&order.destination, &order.mint_in, &a.token_program_in.key());
        require_keys_eq!(to.key(), expected, SolMixError::WrongVault);
        escrow_pay(&a.token_program_in, &a.escrow_in, &a.escrow_mint_in, to.to_account_info(), &order_info, signer, held)?;
        close_escrow(&a.token_program_in, &a.escrow_in, &a.relayer.to_account_info(), &order_info, signer)?;
    }
    Ok(())
}
