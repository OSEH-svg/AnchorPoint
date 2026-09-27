#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};

/// Health factors, multipliers and bonuses are all expressed in basis points
/// so the whole engine stays integer-only.
const BPS: u128 = 10_000;
const BPS_U32: u32 = 10_000;

/// Default per-vault liquidation threshold: 80%.
const DEFAULT_LIQUIDATION_THRESHOLD_BPS: u32 = 8_000;

/// A vault is liquidatable while its health factor is below 1.0.
const MIN_HEALTH_FACTOR_BPS: u128 = 10_000;

/// Partial liquidation restores the vault to at least 1.25.
const TARGET_HEALTH_FACTOR_BPS: u128 = 12_500;

/// Partial liquidation is only offered for vaults that are close to the
/// liquidation line. Deeply underwater vaults are better served by a full
/// liquidation: repaying debt pro-rata out of a vault whose collateral is
/// already worth less than its debt pushes the health factor further down.
const PARTIAL_LIQUIDATION_MIN_HF_BPS: u128 = 9_500;

/// A single partial liquidation call may never repay more than half the
/// outstanding debt, no matter what the liquidator asks for.
const MAX_PARTIAL_COVER_BPS: u128 = 5_000;

/// Liquidator cut on the collateral they seize, 5%.
const LIQUIDATOR_BONUS_BPS: u128 = 500;

/// Flat fee paid to a liquidator on a full liquidation.
const LIQUIDATION_FLAT_FEE: u128 = 10;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vault {
    pub owner: Address,
    pub collateral_amount: u128,
    pub debt_amount: u128,
    /// Health factor = collateral_amount * liquidation_threshold_bps / debt_amount
    pub liquidation_threshold_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Vaults(u32), // Vault ID
    OracleId,    // Address of the Oracle contract
    NextVaultId,
}

#[contract]
pub struct LiquidationEngine;

#[contractimpl]
impl LiquidationEngine {
    pub fn initialize(env: Env, oracle_id: Address) {
        if env.storage().instance().has(&DataKey::OracleId) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::OracleId, &oracle_id);
        env.storage().instance().set(&DataKey::NextVaultId, &1u32);
    }

    pub fn create_vault(env: Env, owner: Address, collateral: u128, debt: u128) -> u32 {
        owner.require_auth();
        let id: u32 = env.storage().instance().get(&DataKey::NextVaultId).unwrap();

        let vault = Vault {
            owner: owner.clone(),
            collateral_amount: collateral,
            debt_amount: debt,
            liquidation_threshold_bps: DEFAULT_LIQUIDATION_THRESHOLD_BPS,
        };
        env.storage().persistent().set(&DataKey::Vaults(id), &vault);

        env.storage().instance().set(
            &DataKey::NextVaultId,
            &id.checked_add(1).expect("vault id overflow"),
        );

        id
    }

    pub fn get_vault(env: Env, vault_id: u32) -> Vault {
        env.storage()
            .persistent()
            .get(&DataKey::Vaults(vault_id))
            .expect("vault not found")
    }

    /// Owner-tunable liquidation threshold. Must stay within (0, 100%].
    pub fn set_liquidation_threshold(env: Env, vault_id: u32, threshold_bps: u32) {
        let mut vault = Self::get_vault(env.clone(), vault_id);
        vault.owner.require_auth();
        assert!(
            threshold_bps > 0 && threshold_bps <= BPS_U32,
            "invalid liquidation threshold"
        );
        vault.liquidation_threshold_bps = threshold_bps;
        env.storage()
            .persistent()
            .set(&DataKey::Vaults(vault_id), &vault);
    }

    /// HF = (collateral * liquidation_threshold) / debt, in bps.
    /// A fully liquidated vault (no debt) reports `u128::MAX`.
    pub fn health_factor(env: Env, vault_id: u32) -> u128 {
        let vault = Self::get_vault(env.clone(), vault_id);
        Self::health_factor_of(&vault)
    }

    /// Debt repayment that lifts the vault to at least the 1.25 target, taking
    /// the liquidator bonus into account. Useful for sizing a partial
    /// liquidation off-chain; `partial_liquidate` clamps to this value.
    pub fn debt_to_cover_for_target(env: Env, vault_id: u32) -> u128 {
        let vault = Self::get_vault(env.clone(), vault_id);
        Self::debt_cover_for_target(&vault)
    }

    /// Full liquidation: clears the whole position. Reserved for vaults that
    /// are too unhealthy to be rescued by a partial liquidation.
    pub fn liquidate(env: Env, liquidator: Address, vault_id: u32) {
        liquidator.require_auth();
        let mut vault: Vault = Self::get_vault(env.clone(), vault_id);

        let health_factor = Self::health_factor_of(&vault);
        assert!(health_factor < MIN_HEALTH_FACTOR_BPS, "vault is healthy");

        let debt_repaid = vault.debt_amount;
        let collateral_seized = vault.collateral_amount;
        // 5% spread plus a flat fee, never more than the collateral on hand.
        let spread = collateral_seized
            .checked_mul(5_u128)
            .expect("incentive overflow")
            / 100;
        let liquidator_bonus = spread
            .checked_add(LIQUIDATION_FLAT_FEE)
            .expect("incentive overflow")
            .min(collateral_seized);

        vault.collateral_amount = 0;
        vault.debt_amount = 0;

        env.storage()
            .persistent()
            .set(&DataKey::Vaults(vault_id), &vault);

        // Topic: event name + liquidator; amounts in data.
        env.events().publish(
            (symbol_short!("liquidate"), liquidator),
            (vault_id, debt_repaid, collateral_seized, liquidator_bonus),
        );
    }

    /// Partial liquidation: the liquidator asks to cover `debt_to_cover` and the
    /// engine repays the smaller of
    ///   * what was asked for,
    ///   * the 50% per-call cap,
    ///   * what is actually needed to reach the 1.25 target, and
    ///   * what the remaining collateral can pay for.
    ///
    /// Collateral is seized at the vault's liquidation threshold plus a 5%
    /// liquidator bonus, so a partial liquidation always leaves the owner with
    /// a healthier vault instead of wiping them out.
    pub fn partial_liquidate(env: Env, liquidator: Address, vault_id: u32, debt_to_cover: u128) {
        liquidator.require_auth();
        assert!(debt_to_cover > 0, "debt to cover must be positive");

        let mut vault: Vault = Self::get_vault(env.clone(), vault_id);
        let health_factor = Self::health_factor_of(&vault);
        assert!(health_factor < MIN_HEALTH_FACTOR_BPS, "vault is healthy");
        assert!(
            health_factor >= PARTIAL_LIQUIDATION_MIN_HF_BPS,
            "vault too unhealthy for partial liquidation"
        );

        let threshold = vault.liquidation_threshold_bps as u128;

        // Per-call cap: at most half of the outstanding debt.
        let max_cover = vault
            .debt_amount
            .checked_mul(MAX_PARTIAL_COVER_BPS)
            .expect("cover overflow")
            / BPS;

        // Never repay more than the vault needs to reach the target HF.
        let needed = Self::debt_cover_for_target(&vault);

        // Never seize collateral the vault does not have.
        let seizure_rate = threshold
            .checked_mul(BPS + LIQUIDATOR_BONUS_BPS)
            .expect("seizure overflow");
        let affordable = vault
            .collateral_amount
            .checked_mul(BPS)
            .expect("seizure overflow")
            .checked_mul(BPS)
            .expect("seizure overflow")
            / seizure_rate;

        let covered = debt_to_cover.min(max_cover).min(needed).min(affordable);
        assert!(covered > 0, "nothing to liquidate");

        // Collateral seized at the liquidation threshold, plus the bonus.
        let seized = covered.checked_mul(threshold).expect("seizure overflow") / BPS;
        let bonus = seized
            .checked_mul(LIQUIDATOR_BONUS_BPS)
            .expect("bonus overflow")
            / BPS;
        let total_seized = seized.checked_add(bonus).expect("seizure overflow");

        vault.debt_amount = vault
            .debt_amount
            .checked_sub(covered)
            .expect("debt underflow");
        vault.collateral_amount = vault
            .collateral_amount
            .checked_sub(total_seized)
            .expect("collateral underflow");

        env.storage()
            .persistent()
            .set(&DataKey::Vaults(vault_id), &vault);

        // Topic: event name + liquidator; amounts and resulting HF in data.
        env.events().publish(
            (symbol_short!("pliq"), liquidator),
            (
                vault_id,
                covered,
                seized,
                bonus,
                Self::health_factor_of(&vault),
            ),
        );
    }

    /// HF = collateral * threshold / debt, in bps. A debt-free vault is
    /// infinitely healthy.
    fn health_factor_of(vault: &Vault) -> u128 {
        if vault.debt_amount == 0 {
            return u128::MAX;
        }
        vault
            .collateral_amount
            .checked_mul(vault.liquidation_threshold_bps as u128)
            .expect("health factor overflow")
            / vault.debt_amount
    }

    /// Smallest debt repayment `d` satisfying
    ///   (collateral - d * rate) * threshold = target * (debt - d)
    /// where `rate = threshold * (1 + bonus)` is the collateral removed per unit
    /// of debt covered. Rounded up so integer truncation can never leave the
    /// vault short of the target.
    fn debt_cover_for_target(vault: &Vault) -> u128 {
        let threshold = vault.liquidation_threshold_bps as u128;
        let target = TARGET_HEALTH_FACTOR_BPS;
        let scale = BPS.checked_mul(BPS).expect("scale overflow");
        let rate = threshold
            .checked_mul(BPS + LIQUIDATOR_BONUS_BPS)
            .expect("rate overflow");

        // denominator = target * scale - rate * threshold
        let denominator = target
            .checked_mul(scale)
            .expect("target overflow")
            .checked_sub(rate.checked_mul(threshold).expect("rate overflow"))
            .expect("liquidation threshold too high");

        // numerator = (target * debt - collateral * threshold) * scale
        let numerator = target
            .checked_mul(vault.debt_amount)
            .expect("target overflow")
            .checked_mul(scale)
            .expect("target overflow")
            .saturating_sub(
                vault
                    .collateral_amount
                    .checked_mul(threshold)
                    .expect("collateral overflow")
                    .checked_mul(scale)
                    .expect("collateral overflow"),
            );

        if numerator == 0 {
            return 0;
        }
        // Ceiling division, so integer truncation can never leave the vault
        // short of the target (and no overflow in numerator + denominator).
        numerator.div_ceil(denominator)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    /// A vault that is liquidatable but recoverable: HF = 0.992.
    /// 124_000 * 8_000 / 100_000 = 9_920 bps.
    const RECOVERABLE_COLLATERAL: u128 = 124_000;
    const RECOVERABLE_DEBT: u128 = 100_000;

    /// A vault that is liquidatable but where the 50% per-call cap binds:
    /// HF = 0.952.
    const CAPPED_COLLATERAL: u128 = 119_000;

    /// A deeply underwater vault: HF = 0.4.
    const UNDERWATER_COLLATERAL: u128 = 100_000;
    const UNDERWATER_DEBT: u128 = 200_000;

    fn setup() -> (Env, LiquidationEngineClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(LiquidationEngine, ());
        let client = LiquidationEngineClient::new(&env, &id);
        client.initialize(&Address::generate(&env));
        let owner = Address::generate(&env);
        (env, client, owner)
    }

    /// Expected collateral seized (excluding bonus) for `covered` at `threshold`.
    fn seized(covered: u128, threshold: u128) -> u128 {
        covered * threshold / BPS
    }

    fn bonus(seized: u128) -> u128 {
        seized * LIQUIDATOR_BONUS_BPS / BPS
    }

    #[test]
    fn test_vault_ids_are_sequential() {
        let (env, client, owner) = setup();
        assert_eq!(client.create_vault(&owner, &1_000, &500), 1);
        assert_eq!(client.create_vault(&owner, &2_000, &500), 2);
        assert_eq!(client.create_vault(&owner, &3_000, &500), 3);
        assert_eq!(client.get_vault(&3).collateral_amount, 3_000);
        drop(env);
    }

    #[test]
    fn test_vault_defaults_and_getters() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);

        let vault = client.get_vault(&id);
        assert_eq!(vault.owner, owner);
        assert_eq!(vault.collateral_amount, RECOVERABLE_COLLATERAL);
        assert_eq!(vault.debt_amount, RECOVERABLE_DEBT);
        assert_eq!(
            vault.liquidation_threshold_bps,
            DEFAULT_LIQUIDATION_THRESHOLD_BPS
        );
        assert_eq!(client.health_factor(&id), 9_920);
        drop(env);
    }

    #[test]
    fn test_health_factor_is_inversely_proportional_to_debt() {
        let (env, client, owner) = setup();

        // Same collateral, less debt -> higher HF.
        let a = client.create_vault(&owner, &100_000, &50_000);
        let b = client.create_vault(&owner, &100_000, &200_000);
        assert_eq!(client.health_factor(&a), 16_000); // 1.6
        assert_eq!(client.health_factor(&b), 4_000); // 0.4

        // A debt-free vault is infinitely healthy.
        let c = client.create_vault(&owner, &0, &0);
        assert_eq!(client.health_factor(&c), u128::MAX);
        drop(env);
    }

    #[test]
    fn test_liquidation_threshold_moves_the_health_factor() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &119_000, &100_000);
        // 80% threshold -> 0.952, liquidatable.
        assert_eq!(client.health_factor(&id), 9_520);

        // 90% threshold -> 1.071, healthy.
        client.set_liquidation_threshold(&id, &9_000);
        assert_eq!(client.get_vault(&id).liquidation_threshold_bps, 9_000);
        assert_eq!(client.health_factor(&id), 10_710);
        drop(env);
    }

    #[test]
    #[should_panic(expected = "vault is healthy")]
    fn test_full_liquidation_rejects_healthy_vault() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &160_000, &100_000); // HF 1.28
        let liquidator = Address::generate(&env);
        client.liquidate(&liquidator, &id);
    }

    #[test]
    fn test_full_liquidation_clears_the_vault() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &UNDERWATER_COLLATERAL, &UNDERWATER_DEBT);
        let liquidator = Address::generate(&env);

        client.liquidate(&liquidator, &id);

        let vault = client.get_vault(&id);
        assert_eq!(vault.debt_amount, 0);
        assert_eq!(vault.collateral_amount, 0);
        assert_eq!(client.health_factor(&id), u128::MAX);
        drop(env);
    }

    #[test]
    fn test_partial_liquidation_restores_target_health_factor() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);
        let liquidator = Address::generate(&env);

        assert_eq!(client.health_factor(&id), 9_920);
        // Repaying the full 50% cap would overshoot, so the engine trims it to
        // what the vault actually needs to get back to 1.25.
        let needed = client.debt_to_cover_for_target(&id);
        assert_eq!(needed, 44_637);

        client.partial_liquidate(&liquidator, &id, &50_000);

        let vault = client.get_vault(&id);
        assert_eq!(vault.debt_amount, 55_363);
        assert_eq!(vault.collateral_amount, 86_506);
        // At or above the 1.25 target, and the vault is safe again.
        assert!(client.health_factor(&id) >= TARGET_HEALTH_FACTOR_BPS);
        assert_eq!(client.health_factor(&id), 12_500);
        drop(env);
    }

    #[test]
    fn test_partial_liquidation_seizes_threshold_plus_bonus() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);
        let liquidator = Address::generate(&env);

        let covered = 44_637;
        let expected_seized = seized(covered, DEFAULT_LIQUIDATION_THRESHOLD_BPS as u128);
        let expected_bonus = bonus(expected_seized);
        assert_eq!(expected_seized, 35_709);
        assert_eq!(expected_bonus, 1_785);

        client.partial_liquidate(&liquidator, &id, &covered);

        let vault = client.get_vault(&id);
        assert_eq!(
            vault.collateral_amount,
            RECOVERABLE_COLLATERAL - expected_seized - expected_bonus
        );
        assert_eq!(vault.debt_amount, RECOVERABLE_DEBT - covered);
        drop(env);
    }

    #[test]
    fn test_partial_liquidation_caps_cover_at_half_the_debt() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &CAPPED_COLLATERAL, &100_000);
        let liquidator = Address::generate(&env);

        // HF 0.952 is too deep to be fixed inside one call, so the 50% cap
        // binds rather than the target.
        assert!(client.debt_to_cover_for_target(&id) > 50_000);
        assert_eq!(client.health_factor(&id), 9_520);

        // Asking for the entire debt still only repays half of it.
        client.partial_liquidate(&liquidator, &id, &100_000);

        let vault = client.get_vault(&id);
        assert_eq!(vault.debt_amount, 50_000);
        assert_eq!(vault.collateral_amount, 77_000);
        // Left safe but below target: further liquidation is no longer needed.
        let health_factor = client.health_factor(&id);
        assert!(health_factor >= MIN_HEALTH_FACTOR_BPS);
        assert!(health_factor < TARGET_HEALTH_FACTOR_BPS);
        assert_eq!(health_factor, 12_320);
        drop(env);
    }

    #[test]
    fn test_partial_liquidation_preserves_owner_collateral_vs_full() {
        let (env, client, owner) = setup();
        let liquidator = Address::generate(&env);
        let partial_id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);
        let full_id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);

        client.partial_liquidate(&liquidator, &partial_id, &50_000);
        client.liquidate(&liquidator, &full_id);

        let partial = client.get_vault(&partial_id);
        let full = client.get_vault(&full_id);

        // Same starting position: the partial path leaves the owner solvent and
        // the vault healthy, the full path leaves them with nothing.
        assert!(partial.collateral_amount > 0);
        assert_eq!(partial.collateral_amount, 86_506);
        assert!(partial.debt_amount > 0);
        assert!(client.health_factor(&partial_id) >= MIN_HEALTH_FACTOR_BPS);

        assert_eq!(full.collateral_amount, 0);
        assert_eq!(full.debt_amount, 0);

        // The whole point of the feature: the owner keeps collateral *and* a
        // debt position that is now over-collateralised, instead of losing both.
        assert!(partial.collateral_amount > full.collateral_amount);
        assert!(partial.debt_amount > full.debt_amount);
        drop(env);
    }

    #[test]
    #[should_panic(expected = "vault too unhealthy for partial liquidation")]
    fn test_partial_liquidation_rejects_deeply_underwater_vault() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &UNDERWATER_COLLATERAL, &UNDERWATER_DEBT);
        let liquidator = Address::generate(&env);
        // HF 0.4: pro-rata repayment would push the health factor down further.
        client.partial_liquidate(&liquidator, &id, &100_000);
    }

    #[test]
    #[should_panic(expected = "vault is healthy")]
    fn test_partial_liquidation_rejects_healthy_vault() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &160_000, &100_000); // HF 1.28
        let liquidator = Address::generate(&env);
        client.partial_liquidate(&liquidator, &id, &1_000);
    }

    #[test]
    #[should_panic(expected = "debt to cover must be positive")]
    fn test_partial_liquidation_rejects_zero_cover() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &RECOVERABLE_COLLATERAL, &RECOVERABLE_DEBT);
        let liquidator = Address::generate(&env);
        client.partial_liquidate(&liquidator, &id, &0);
    }

    #[test]
    #[should_panic(expected = "vault not found")]
    fn test_missing_vault_panics() {
        let (env, client, _owner) = setup();
        client.get_vault(&99);
        drop(env);
    }

    #[test]
    #[should_panic(expected = "invalid liquidation threshold")]
    fn test_threshold_above_one_hundred_percent_panics() {
        let (env, client, owner) = setup();
        let id = client.create_vault(&owner, &1_000, &500);
        client.set_liquidation_threshold(&id, &10_001);
        drop(env);
    }
}
