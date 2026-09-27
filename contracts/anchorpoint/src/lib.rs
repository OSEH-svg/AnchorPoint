#![no_std]

pub mod admin;
pub mod rate_limit;
pub mod storage_keys;

#[cfg(test)]
mod tests;

use soroban_sdk::contracterror;

/// Explicit error codes replacing generic panics across AnchorPoint contracts.
///
/// Using `#[contracterror]` ensures every error surface is machine-readable
/// (u32 code) and observable in transaction results without parsing raw panic
/// strings.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Caller is not the authorised admin.
    Unauthorized = 1,
    /// Contract has already been initialised.
    AlreadyInitialized = 2,
    /// The supplied amount is zero or negative.
    InvalidAmount = 3,
    /// The caller's balance is too low for the requested operation.
    InsufficientBalance = 4,
    /// The caller's allowance is too low for the requested operation.
    InsufficientAllowance = 5,
    /// The deposit would push total supply past the configured cap.
    SupplyCapExceeded = 6,
    /// The requested operation is blocked while the contract is paused.
    ContractPaused = 7,
    /// A required storage entry was not found.
    NotInitialized = 8,
    /// The provided batch exceeds the maximum allowed size.
    BatchTooLarge = 9,
    /// The provided batch is empty.
    EmptyBatch = 10,
}

#[soroban_sdk::contract]
pub struct AnchorPointContract;
