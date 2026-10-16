use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use pinocchio_idl_macros::p_state;
use crate::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_bn254::prelude::{alt_bn128_addition, alt_bn128_multiplication, alt_bn128_pairing};

/// Uncompressed Groth16 proof format expected by groth16-solana.
///
/// All coordinates are big-endian. Total size: 256 bytes (64 + 128 + 64).
///
/// - `a`: G1 point, 64 bytes (x[32] || y[32]).
/// - `b`: G2 point, 128 bytes (x_c1[32] || x_c0[32] || y_c1[32] || y_c0[32]),
///   in the coordinate ordering arkworks/groth16-solana expect. The TypeScript
///   converter is responsible for swapping snarkjs's [c0, c1] ordering to the
///   [c1, c0] ordering used here.
/// - `c`: G1 point, 64 bytes (x[32] || y[32]).
///
/// IMPORTANT: `a` is the *raw* (non-negated) proof_a as produced by snarkjs /
/// rapidsnark. `groth16-solana`'s `Groth16Verifier::new` requires the negated
/// proof_a, so `verify_groth16` negates it on-chain before verification. This
/// keeps the client side trivial (no curve math in TypeScript).
#[p_state]
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug)]
pub struct UncompressedProof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

/// BN254 base field modulus q, big-endian.
///
/// q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
const FIELD_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// Negate a big-endian field element `y` in Fq, returning `(q - y) mod q`.
///
/// For a G1 affine point `(x, y)`, the curve negation is `(x, q - y)`. Returns
/// `0` when `y == 0` (the point at infinity / identity y-coordinate).
fn negate_field_be(y: &[u8; 32]) -> [u8; 32] {
    // If y == 0, -y == 0.
    if y.iter().all(|&b| b == 0) {
        return [0u8; 32];
    }
    // result = q - y, computed as big-endian subtraction with borrow.
    let mut result = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let diff = FIELD_MODULUS_BE[i] as i16 - y[i] as i16 - borrow;
        if diff < 0 {
            result[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            result[i] = diff as u8;
            borrow = 0;
        }
    }
    result
}

/// Negate proof_a in place: (x, y) -> (x, q - y).
pub fn negate_proof_a(proof_a: &mut [u8; 64]) -> Result<()> {
    let y: [u8; 32] = proof_a[32..64]
        .try_into()
        .map_err(|_| ProgramError::InvalidArgument)?;
    let neg_y = negate_field_be(&y);
    proof_a[32..64].copy_from_slice(&neg_y);
    Ok(())
}

/// `acc += ic * scalar` using stack buffers only (no heap Vec/.concat).
pub fn g1_mul_add(acc: &mut [u8; 64], ic: &[u8; 64], scalar: &[u8; 32]) -> Result<()> {
    let mut scalar_fr = *scalar;
    crate::poseidon_hash::reduce_fr_be(&mut scalar_fr);
    let mut mul_in = [0u8; 96];
    mul_in[..64].copy_from_slice(ic);
    mul_in[64..].copy_from_slice(&scalar_fr);
    let mul_res =
        alt_bn128_multiplication(&mul_in).map_err(|_| ProgramError::InvalidArgument)?;
    if mul_res.len() < 64 {
        return Err(ProgramError::InvalidArgument.into());
    }

    let mut add_in = [0u8; 128];
    add_in[..64].copy_from_slice(&mul_res[..64]);
    add_in[64..].copy_from_slice(acc);
    let add_res = alt_bn128_addition(&add_in).map_err(|_| ProgramError::InvalidArgument)?;
    if add_res.len() < 64 {
        return Err(ProgramError::InvalidArgument.into());
    }
    acc.copy_from_slice(&add_res[..64]);
    Ok(())
}

/// `acc += other` (BN254 G1). `(0,0)` is the point at infinity.
pub fn g1_add(acc: &mut [u8; 64], other: &[u8; 64]) -> Result<()> {
    let mut add_in = [0u8; 128];
    add_in[..64].copy_from_slice(acc);
    add_in[64..].copy_from_slice(other);
    let add_res = alt_bn128_addition(&add_in).map_err(|_| ProgramError::InvalidArgument)?;
    if add_res.len() < 64 {
        return Err(ProgramError::InvalidArgument.into());
    }
    acc.copy_from_slice(&add_res[..64]);
    Ok(())
}

/// Fold `public_inputs[start..start+count]` into `prepared` using `vk.vk_ic`.
///
/// `prepared` must already hold the partial sum (initially `vk_ic[0]`).
/// Processes at most `count` inputs starting at `start` (0-based public-input index).
pub fn prepare_public_inputs_chunk(
    prepared: &mut [u8; 64],
    public_inputs: &[[u8; 32]],
    vk: &Groth16Verifyingkey,
    start: usize,
    count: usize,
) -> Result<()> {
    if start + count > public_inputs.len() {
        return Err(ProgramError::InvalidArgument.into());
    }
    if public_inputs.len() + 1 != vk.vk_ic.len() {
        return Err(ProgramError::InvalidArgument.into());
    }
    for i in start..start + count {
        g1_mul_add(prepared, &vk.vk_ic[i + 1], &public_inputs[i])?;
    }
    Ok(())
}

/// Final Groth16 pairing check with a precomputed prepared-public-input G1.
///
/// Stack-only pairing buffer — avoids the heap `.concat()` in groth16-solana.
pub fn verify_pairing_prepared(
    proof: &UncompressedProof,
    prepared_public_inputs: &[u8; 64],
    vk: &Groth16Verifyingkey,
) -> Result<()> {
    let mut proof_a = proof.a;
    negate_proof_a(&mut proof_a)?;

    // 4 pairs × (G1 64 + G2 128) = 768 bytes
    let mut pairing_input = [0u8; 768];
    let mut off = 0usize;
    for chunk in [
        proof_a.as_slice(),
        proof.b.as_slice(),
        prepared_public_inputs.as_slice(),
        vk.vk_gamme_g2.as_slice(),
        proof.c.as_slice(),
        vk.vk_delta_g2.as_slice(),
        vk.vk_alpha_g1.as_slice(),
        vk.vk_beta_g2.as_slice(),
    ] {
        pairing_input[off..off + chunk.len()].copy_from_slice(chunk);
        off += chunk.len();
    }
    if off != 768 {
        return Err(ProgramError::InvalidArgument.into());
    }

    let pairing_res =
        alt_bn128_pairing(&pairing_input).map_err(|_| ProgramError::InvalidArgument)?;
    if pairing_res.len() < 32 || pairing_res[31] != 1 {
        return Err(ProgramError::InvalidArgument.into());
    }
    Ok(())
}

/// Verify a Groth16 proof using the Solana alt_bn128 syscalls.
///
/// Accepts an *uncompressed*, non-negated proof (as emitted by snarkjs /
/// rapidsnark and converted to bytes by the TypeScript client). proof_a is
/// negated on-chain to satisfy `groth16-solana`'s verifier convention.
///
/// # Type Parameters
/// - `N`: Number of public inputs (must match `vk.nr_pubinputs`).
///
/// # Arguments
/// - `proof`: Uncompressed proof (256 bytes total), big-endian coordinates.
/// - `public_inputs`: Array of N public inputs, each 32 bytes big-endian.
/// - `vk`: Verifying key constant.
///
/// # Errors
/// Returns `ProgramError::InvalidArgument` if proof verification fails.
pub fn verify_groth16<const N: usize>(
    proof: &UncompressedProof,
    public_inputs: &[[u8; 32]; N],
    vk: &Groth16Verifyingkey,
) -> Result<()> {
    // Negate proof_a: (x, y) -> (x, q - y).
    let mut proof_a = proof.a;
    negate_proof_a(&mut proof_a)?;

    let mut verifier = Groth16Verifier::new(&proof_a, &proof.b, &proof.c, public_inputs, vk)
        .map_err(|_| ProgramError::InvalidArgument)?;

    // Unchecked: avoids BigUint field-size checks that allocate on the heap.
    // Public inputs are circuit outputs / Poseidon hashes already in Fr.
    verifier
        .verify_unchecked()
        .map_err(|_| ProgramError::InvalidArgument)?;

    Ok(())
}

/// Verify shuffle_main proofs against inputs stored in account data (no stack copy).
/// Prefer the chunked prepare + `verify_pairing_prepared` path on-chain.
pub fn verify_groth16_shuffle(
    proof: &UncompressedProof,
    public_inputs: &[[u8; 32]; 210],
    vk: &Groth16Verifyingkey,
) -> Result<()> {
    verify_groth16::<210>(proof, public_inputs, vk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_vectors::{TEST_PROOF, TEST_PUBLIC_INPUTS, TEST_VERIFYING_KEY};

    #[test]
    fn test_negate_zero_is_zero() {
        assert_eq!(negate_field_be(&[0u8; 32]), [0u8; 32]);
    }

    #[test]
    fn test_negate_is_involution() {
        // q - (q - y) == y for any y in [1, q).
        let mut y = [0u8; 32];
        y[31] = 5;
        let neg = negate_field_be(&y);
        let back = negate_field_be(&neg);
        assert_eq!(back, y);
    }

    /// End-to-end: the uncompressed-proof path with on-chain negation verifies
    /// the known-good groth16-solana test vector.
    #[test]
    fn test_verify_uncompressed_known_proof() {
        let proof = UncompressedProof {
            a: TEST_PROOF[0..64].try_into().unwrap(),
            b: TEST_PROOF[64..192].try_into().unwrap(),
            c: TEST_PROOF[192..256].try_into().unwrap(),
        };
        verify_groth16(&proof, &TEST_PUBLIC_INPUTS, &TEST_VERIFYING_KEY)
            .expect("known-good proof must verify");
    }

    /// Chunked prepare + pairing matches monolithic verify.
    #[test]
    fn test_chunked_prepare_matches_monolithic() {
        let proof = UncompressedProof {
            a: TEST_PROOF[0..64].try_into().unwrap(),
            b: TEST_PROOF[64..192].try_into().unwrap(),
            c: TEST_PROOF[192..256].try_into().unwrap(),
        };
        let mut prepared = TEST_VERIFYING_KEY.vk_ic[0];
        let n = TEST_PUBLIC_INPUTS.len();
        let chunk = 3.min(n);
        let mut start = 0;
        while start < n {
            let count = (n - start).min(chunk);
            prepare_public_inputs_chunk(
                &mut prepared,
                &TEST_PUBLIC_INPUTS,
                &TEST_VERIFYING_KEY,
                start,
                count,
            )
            .unwrap();
            start += count;
        }
        verify_pairing_prepared(&proof, &prepared, &TEST_VERIFYING_KEY)
            .expect("chunked path must verify");
    }

    /// A tampered public input must fail.
    #[test]
    fn test_verify_uncompressed_wrong_inputs_fails() {
        let proof = UncompressedProof {
            a: TEST_PROOF[0..64].try_into().unwrap(),
            b: TEST_PROOF[64..192].try_into().unwrap(),
            c: TEST_PROOF[192..256].try_into().unwrap(),
        };
        let mut bad = TEST_PUBLIC_INPUTS;
        bad[0][0] ^= 0xff;
        assert!(verify_groth16(&proof, &bad, &TEST_VERIFYING_KEY).is_err());
    }
}
