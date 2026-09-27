use soroban_sdk::{contracttype, symbol_short, Env, Symbol};

/// Error codes for reentrancy violations
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReentrancyGuardError {
    ReentrantCall = 1,
}

const REENTRANCY_KEY: Symbol = symbol_short!("REENTRY");

/// RAII guard for reentrancy protection
pub struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    /// Acquire the reentrancy lock. If already locked, returns `Err(ReentrancyGuardError::ReentrantCall)`.
    pub fn new(env: &'a Env) -> Result<Self, ReentrancyGuardError> {
        let locked: bool = env
            .storage()
            .instance()
            .get(&REENTRANCY_KEY)
            .unwrap_or(false);

        if locked {
            return Err(ReentrancyGuardError::ReentrantCall);
        }

        env.storage().instance().set(&REENTRANCY_KEY, &true);
        Ok(Self { env })
    }

    /// Check if the lock is currently held.
    pub fn is_locked(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&REENTRANCY_KEY)
            .unwrap_or(false)
    }
}

impl Drop for ReentrancyGuard<'_> {
    fn drop(&mut self) {
        self.env.storage().instance().set(&REENTRANCY_KEY, &false);
    }
}
