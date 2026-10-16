/// BN254 field element wrapper compatible with arcis encrypted circuits.
/// Represented as (low, high) where value = low + high * 2^128 (mod BN254 prime).
pub type FieldElement = (u128, u128);

pub fn field_element_from_u64(x: u64) -> FieldElement {
    (x as u128, 0)
}

pub fn field_element_from_u128(x: u128) -> FieldElement {
    (x, 0)
}

pub fn field_element_from_low_high(low: u128, high: u128) -> FieldElement {
    (low, high)
}

pub fn field_element_zero() -> FieldElement {
    (0, 0)
}
