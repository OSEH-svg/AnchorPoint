//! FUZZ APPROACH: Option A — proptest
//! Rationale: This module wires together our test helpers, defining a reliable baseline environment for our state machine and property fuzzers to execute against.

#![cfg(test)]

pub mod state_machine_tests;
pub mod fuzz_tests;
pub mod storage_verification;

use soroban_sdk::{testutils::Address as _, Address, Env};
use crate::{GovernanceContract, GovernanceContractClient};
use std::cell::RefCell;
use std::thread_local;

thread_local! {
    pub static DYNAMIC_CONTRACT_ID: RefCell<Option<Address>> = RefCell::new(None);
}

pub fn get_dynamic_contract_id() -> Address {
    DYNAMIC_CONTRACT_ID.with(|id| {
        id.borrow().clone().expect("Contract not registered in test env")
    })
}

/// Returns a pre-initialised environment with 5 voter addresses funded and registered.
pub fn setup_governance_env() -> (Env, GovernanceContractClient<'static>, std::vec::Vec<Address>) {
    let env = Env::default();
    
    // Register the contract natively
    let contract_id = env.register(GovernanceContract, ());
    DYNAMIC_CONTRACT_ID.with(|id| {
        *id.borrow_mut() = Some(contract_id.clone());
    });
    let client = GovernanceContractClient::new(&env, &contract_id);
    
    // Initialize the governance contract parameters (Quorum: 200, Voting Duration: 100 ledgers)
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);
    
    let mut voters = std::vec::Vec::new();
    for _ in 0..5 {
        voters.push(Address::generate(&env));
    }
    
    (env, client, voters)
}

#[test]
fn test_initialization() {
    let env = Env::default();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);
    
    assert_eq!(client.get_admin(), admin);
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_twice_fails() {
    let env = Env::default();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);
    client.initialize(&admin, &200, &100);
}

#[test]
fn test_multisig_council_setup() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let mut council = soroban_sdk::Vec::new(&env);
    council.push_back(signer1.clone());
    council.push_back(signer2.clone());
    council.push_back(signer3.clone());

    client.set_council(&admin, &council, &2);

    assert_eq!(client.get_threshold(), 2);
    assert_eq!(client.get_council_signers().len(), 3);
}

#[test]
fn test_execute_proposal_multisig_threshold_success() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let mut council = soroban_sdk::Vec::new(&env);
    council.push_back(signer1.clone());
    council.push_back(signer2.clone());
    council.push_back(signer3.clone());

    // 2-of-3 multisig threshold
    client.set_council(&admin, &council, &2);

    let prop_id = client.create_proposal(&admin, &soroban_sdk::String::from_str(&env, "Upgrade"));

    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(signer1);
    signers.push_back(signer2);

    let res = client.try_execute_proposal(&prop_id, &signers);
    assert!(res.is_ok());
}

#[test]
fn test_execute_proposal_insufficient_signatures_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut council = soroban_sdk::Vec::new(&env);
    council.push_back(signer1.clone());
    council.push_back(signer2.clone());

    client.set_council(&admin, &council, &2);

    let prop_id = client.create_proposal(&admin, &soroban_sdk::String::from_str(&env, "Upgrade"));

    // Provide only 1 signature when threshold is 2
    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(signer1);

    let err = client.try_execute_proposal(&prop_id, &signers).expect_err("Should fail with insufficient signatures");
    assert_eq!(err, Ok(soroban_sdk::Error::from(crate::GovernanceError::InsufficientSignatures)));
}

#[test]
fn test_execute_proposal_unauthorized_signer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let outsider = Address::generate(&env);

    let mut council = soroban_sdk::Vec::new(&env);
    council.push_back(signer1.clone());
    council.push_back(signer2.clone());

    client.set_council(&admin, &council, &2);

    let prop_id = client.create_proposal(&admin, &soroban_sdk::String::from_str(&env, "Upgrade"));

    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(signer1);
    signers.push_back(outsider);

    let err = client.try_execute_proposal(&prop_id, &signers).expect_err("Should fail with unauthorized signer");
    assert_eq!(err, Ok(soroban_sdk::Error::from(crate::GovernanceError::UnauthorizedSigner)));
}

#[test]
fn test_execute_proposal_duplicate_signer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GovernanceContract, ());
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &200, &100);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut council = soroban_sdk::Vec::new(&env);
    council.push_back(signer1.clone());
    council.push_back(signer2.clone());

    client.set_council(&admin, &council, &2);

    let prop_id = client.create_proposal(&admin, &soroban_sdk::String::from_str(&env, "Upgrade"));

    let mut signers = soroban_sdk::Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer1);

    let err = client.try_execute_proposal(&prop_id, &signers).expect_err("Should fail with duplicate signer");
    assert_eq!(err, Ok(soroban_sdk::Error::from(crate::GovernanceError::DuplicateSigner)));
}
