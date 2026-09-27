use soroban_sdk::Env;

/// Default threshold: 7 days in ledgers (assuming ~5 seconds per ledger).
pub const INSTANCE_THRESHOLD: u32 = 7 * 17_280; // 120,960 ledgers

/// Default extension target: 30 days in ledgers (assuming ~5 seconds per ledger).
pub const INSTANCE_EXTEND_TO: u32 = 30 * 17_280; // 518,400 ledgers

/// Extend the TTL of the current contract instance storage if it is below the threshold.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `threshold` - The minimum number of ledgers remaining before extension is triggered.
/// * `extend_to` - The new TTL (in ledgers) to extend to.
pub fn extend_instance_ttl(env: &Env, threshold: u32, extend_to: u32) {
    env.storage().instance().extend_ttl(threshold, extend_to);
}
