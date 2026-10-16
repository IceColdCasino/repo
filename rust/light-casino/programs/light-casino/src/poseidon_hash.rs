//! BN254 Poseidon via `light-hasher` (Solana syscall on-chain, circom-compatible off-chain).

use crate::prelude::*;

#[cfg(target_os = "solana")]
use light_hasher::Hasher;

#[cfg(not(target_os = "solana"))]
use {
    ark_bn254::Fr,
    light_poseidon::{Poseidon, PoseidonBytesHasher},
};

#[derive(Debug, PartialEq, Eq)]
pub enum PoseidonError {
    UnsupportedWidth,
    HashFailed,
}

impl From<light_hasher::errors::HasherError> for PoseidonError {
    fn from(_: light_hasher::errors::HasherError) -> Self {
        PoseidonError::HashFailed
    }
}

/// BN254 scalar field, big-endian. Circom reduces every signal modulo this prime.
const BN254_FR_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Reduce a big-endian integer into the BN254 scalar field.
///
/// Any 32-byte value is strictly less than `6 * Fr`, so six subtractions suffice.
pub fn reduce_fr_be(value: &mut [u8; 32]) {
    for _ in 0..6 {
        if *value < BN254_FR_BE {
            return;
        }
        let mut borrow: u16 = 0;
        for i in (0..32).rev() {
            let av = value[i] as u16;
            let bv = BN254_FR_BE[i] as u16 + borrow;
            if av >= bv {
                value[i] = (av - bv) as u8;
                borrow = 0;
            } else {
                value[i] = (av + 256 - bv) as u8;
                borrow = 1;
            }
        }
    }
}

/// Poseidon-hash `inputs.len()` big-endian 32-byte field elements (circom compatible, max 12).
///
/// Inputs are copied and reduced modulo Fr first. A staged limb can sit above the
/// scalar field while the prover's signal was that limb mod Fr; hashing the
/// residue is what the circuit did.
pub fn poseidon_fields_be(inputs: &[&[u8]]) -> Result<[u8; 32]> {
    if inputs.is_empty() || inputs.len() > 12 {
        return Err(error!(crate::ErrorCode::InvalidPublicInputs));
    }
    let mut owned = [[0u8; 32]; 12];
    for (i, input) in inputs.iter().enumerate() {
        if input.len() != 32 {
            return Err(error!(crate::ErrorCode::InvalidPublicInputs));
        }
        owned[i].copy_from_slice(input);
        reduce_fr_be(&mut owned[i]);
    }
    let mut refs: [&[u8]; 12] = [&[]; 12];
    for i in 0..inputs.len() {
        refs[i] = owned[i].as_slice();
    }
    let reduced = &refs[..inputs.len()];

    #[cfg(target_os = "solana")]
    {
        light_hasher::Poseidon::hashv(reduced)
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))
    }
    #[cfg(not(target_os = "solana"))]
    {
        let mut hasher = Poseidon::<Fr>::new_circom(reduced.len())
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))?;
        hasher
            .hash_bytes_be(reduced)
            .map_err(|_| error!(crate::ErrorCode::InvalidPublicInputs))
    }
}

/// Stack-friendly Poseidon for at most 12 field arrays (off-chain tests / small arity).
pub fn poseidon_hash(inputs: &[[u8; 32]]) -> std::result::Result<[u8; 32], PoseidonError> {
    if inputs.is_empty() || inputs.len() > 12 {
        return Err(PoseidonError::UnsupportedWidth);
    }
    let refs: Vec<&[u8]> = inputs.iter().map(|x| x.as_slice()).collect();
    poseidon_fields_be(&refs).map_err(|_| PoseidonError::HashFailed)
}

extern crate alloc;

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(n: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..32].copy_from_slice(&n.to_be_bytes());
        out
    }

    #[test]
    fn poseidon_two_inputs_is_deterministic() {
        let a = poseidon_hash(&[fe(1), fe(2)]).unwrap();
        let b = poseidon_hash(&[fe(1), fe(2)]).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, [0u8; 32]);
    }

    #[test]
    fn poseidon_matches_known_circom_vector() {
        let expected: [u8; 32] = [
            0x11, 0x5c, 0xc0, 0xf5, 0xe7, 0xd6, 0x90, 0x41, 0x3d, 0xf6, 0x4c, 0x6b, 0x96, 0x62,
            0xe9, 0xcf, 0x2a, 0x36, 0x17, 0xf2, 0x74, 0x32, 0x45, 0x51, 0x9e, 0x19, 0x60, 0x7a,
            0x44, 0x17, 0x18, 0x9a,
        ];
        let got = poseidon_hash(&[fe(1), fe(2)]).unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn poseidon_reduces_multiples_of_the_scalar_field() {
        let mut modulus = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81,
            0x58, 0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93,
            0xf0, 0x00, 0x00, 0x01,
        ];
        let zero = poseidon_hash(&[fe(0), fe(1)]).unwrap();
        let reduced = poseidon_hash(&[modulus, fe(1)]).unwrap();
        assert_eq!(reduced, zero);
        // Fr + 7 reduces to 7.
        modulus[31] = modulus[31].wrapping_add(7);
        let seven = poseidon_hash(&[fe(7), fe(1)]).unwrap();
        assert_eq!(poseidon_hash(&[modulus, fe(1)]).unwrap(), seven);
    }

    #[test]
    fn poseidon_fields_be_twelve_inputs_off_chain() {
        let chunk = [fe(0); 12];
        let refs: Vec<&[u8]> = chunk.iter().map(|x| x.as_slice()).collect();
        let h = poseidon_fields_be(&refs).unwrap();
        assert_ne!(h, [0u8; 32]);
    }
}
