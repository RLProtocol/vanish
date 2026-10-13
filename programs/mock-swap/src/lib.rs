//! Test-only stand-in for the Jupiter aggregator. Never deployed to mainnet.
//!
//! Speaks the same CPI shape SolMix uses for real routes: the caller's order PDA signs as the
//! user, tokens leave its input account and arrive in its output account from a reserve.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("9rX8mRUjYP6yugEcM9DtzZriTDaRheNQuPHQeSk4f1uB");

pub const RESERVE_SEED: &[u8] = b"reserve";

#[program]
pub mod mock_swap {
    use super::*;

    /// Takes `amount_in` from `user_in` and pays exactly `amount_out` into `user_out`.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, amount_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program_in.to_account_info(),
                TransferChecked {
                    from: a.user_in.to_account_info(),
                    mint: a.mint_in.to_account_info(),
                    to: a.reserve_in.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            amount_in,
            a.mint_in.decimals,
        )?;
        let seeds: &[&[u8]] = &[RESERVE_SEED, &[ctx.bumps.reserve]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program_out.to_account_info(),
                TransferChecked {
                    from: a.reserve_out.to_account_info(),
                    mint: a.mint_out.to_account_info(),
                    to: a.user_out.to_account_info(),
                    authority: a.reserve.to_account_info(),
                },
                &[seeds],
            ),
            amount_out,
            a.mint_out.decimals,
        )
    }

    /// A malicious "route": tries to move tokens out of any account using the user's signature.
    pub fn steal(ctx: Context<Steal>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.to_account_info(),
                TransferChecked {
                    from: a.victim.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.thief.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            amount,
            a.mint.decimals,
        )
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_out: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA that owns the reserves
    #[account(seeds = [RESERVE_SEED], bump)]
    pub reserve: UncheckedAccount<'info>,
    #[account(mut)]
    pub reserve_in: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub reserve_out: InterfaceAccount<'info, TokenAccount>,
    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Steal<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub victim: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub thief: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}
