import { dlopen, FFIType, ptr, suffix } from 'bun:ffi';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Groth16Proof } from 'snarkjs';

// Error codes
const PROVER_OK = 0x0;
const PROVER_ERROR = 0x1;
const PROVER_ERROR_SHORT_BUFFER = 0x2;
const PROVER_INVALID_WITNESS_LENGTH = 0x3;

const VERIFIER_VALID_PROOF = 0x0;
const VERIFIER_INVALID_PROOF = 0x1;
const VERIFIER_ERROR = 0x2;

// Load the rapidsnark library
const rapidsnarkPath = path.join(__dirname, `../rapidsnark/lib/librapidsnark.${suffix}`);

const lib = dlopen(rapidsnarkPath, {
  // Prover functions
  groth16_prover: {
    args: [
      FFIType.ptr,      // zkey_buffer
      FFIType.u64,      // zkey_size
      FFIType.ptr,      // wtns_buffer
      FFIType.u64,      // wtns_size
      FFIType.ptr,      // proof_buffer
      FFIType.ptr,      // proof_size (in/out)
      FFIType.ptr,      // public_buffer
      FFIType.ptr,      // public_size (in/out)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  // Stateful prover API
  groth16_prover_create: {
    args: [
      FFIType.ptr,      // prover_object (out)
      FFIType.ptr,      // zkey_buffer
      FFIType.u64,      // zkey_size
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_prover_prove: {
    args: [
      FFIType.u64,      // prover_object (pointer value as u64)
      FFIType.ptr,      // wtns_buffer
      FFIType.u64,      // wtns_size
      FFIType.ptr,      // proof_buffer
      FFIType.ptr,      // proof_size (in/out)
      FFIType.ptr,      // public_buffer
      FFIType.ptr,      // public_size (in/out)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_prover_destroy: {
    args: [FFIType.u64], // prover_object (pointer value as u64)
    returns: FFIType.void,
  },
  groth16_public_size_for_zkey_buf: {
    args: [
      FFIType.ptr,      // zkey_buffer
      FFIType.u64,      // zkey_size
      FFIType.ptr,      // public_size (out)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_prover_zkey_file: {
    args: [
      FFIType.ptr,      // zkey_file_path (null-terminated string)
      FFIType.ptr,      // wtns_buffer
      FFIType.u64,      // wtns_size
      FFIType.ptr,      // proof_buffer
      FFIType.ptr,      // proof_size (in/out)
      FFIType.ptr,      // public_buffer
      FFIType.ptr,      // public_size (in/out)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_prover_create_zkey_file: {
    args: [
      FFIType.ptr,      // prover_object (out)
      FFIType.ptr,      // zkey_file_path (null-terminated string)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_public_size_for_zkey_file: {
    args: [
      FFIType.ptr,      // zkey_file_path (null-terminated string)
      FFIType.ptr,      // public_size (out)
      FFIType.ptr,      // error_msg
      FFIType.u64,      // error_msg_maxsize
    ],
    returns: FFIType.int,
  },
  groth16_proof_size: {
    args: [
      FFIType.ptr,      // proof_size (out)
    ],
    returns: FFIType.void,
  },
  // Verifier function - takes only 5 args, not 8
  groth16_verify: {
    args: [
      FFIType.ptr,      // proof (null-terminated JSON string)
      FFIType.ptr,      // inputs (null-terminated JSON string)
      FFIType.ptr,      // verification_key (null-terminated JSON string)
      FFIType.ptr,      // error_msg buffer
      FFIType.u64,      // error_msg_maxsize (unsigned long on macOS)
    ],
    returns: FFIType.int,
  },
});

// Export getBufferSizes for use by the Prover class
export function getBufferSizes(zkeyData: Uint8Array): { proofSize: number; publicSize: number } {
  const errorMsgSize = 256;
  const errorMsgBuffer = new Uint8Array(errorMsgSize);
  
  // Get public signals size
  const publicSizeBuffer = new BigUint64Array(1);
  const publicSizeResult = lib.symbols.groth16_public_size_for_zkey_buf(
    ptr(zkeyData),
    BigInt(zkeyData.length),
    ptr(publicSizeBuffer),
    ptr(errorMsgBuffer),
    BigInt(errorMsgSize)
  );
  
  if (publicSizeResult !== PROVER_OK) {
    const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
    throw new Error(`Failed to get public size: ${errorMsg || `error code ${publicSizeResult}`}`);
  }
  
  // Get proof size
  const proofSizeBuffer = new BigUint64Array(1);
  lib.symbols.groth16_proof_size(ptr(proofSizeBuffer));
  
  // Add safety margin to avoid edge cases with buffer sizing
  const PROOF_MARGIN = 100;
  const PUBLIC_MARGIN = 100;
  
  return {
    proofSize: Number(proofSizeBuffer[0]) + PROOF_MARGIN,
    publicSize: Number(publicSizeBuffer[0]) + PUBLIC_MARGIN,
  };
}

// Stateful Prover class
export class Prover {
  private proverObject: bigint;
  private proofSize: number;
  private publicSize: number;
  private zkeyData: Uint8Array;

  constructor(zkeyData: Uint8Array) {
    this.zkeyData = zkeyData;
    const errorMsgSize = 256;
    const errorMsgBuffer = new Uint8Array(errorMsgSize);
    const proverObjectBuffer = new BigUint64Array(1);
    
    const result = lib.symbols.groth16_prover_create(
      ptr(proverObjectBuffer),
      ptr(zkeyData),
      BigInt(zkeyData.length),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize)
    );
    
    if (result !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`Failed to create prover: ${errorMsg || `error code ${result}`}`);
    }
    
    this.proverObject = proverObjectBuffer[0]!;
    const sizes = getBufferSizes(zkeyData);
    this.proofSize = sizes.proofSize;
    this.publicSize = sizes.publicSize;
  }

  prove(witnessData: Uint8Array): { proof: Groth16Proof; publicSignals: string[] } {
    const proofBuffer = new Uint8Array(this.proofSize);
    const publicBuffer = new Uint8Array(this.publicSize);
    const proofSizeBuffer = new BigUint64Array([BigInt(this.proofSize)]);
    const publicSizeBuffer = new BigUint64Array([BigInt(this.publicSize)]);
    const errorMsgSize = 256;
    const errorMsgBuffer = new Uint8Array(errorMsgSize);
    
    const result = lib.symbols.groth16_prover_prove(
      this.proverObject,
      ptr(witnessData),
      BigInt(witnessData.length),
      ptr(proofBuffer),
      ptr(proofSizeBuffer),
      ptr(publicBuffer),
      ptr(publicSizeBuffer),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize)
    );
    
    if (result === PROVER_ERROR_SHORT_BUFFER) {
      // Buffers were too small, try again with required sizes
      const requiredProofSize = Number(proofSizeBuffer[0]);
      const requiredPublicSize = Number(publicSizeBuffer[0]);
      
      const proofBuffer2 = new Uint8Array(requiredProofSize);
      const publicBuffer2 = new Uint8Array(requiredPublicSize);
      const proofSizeBuffer2 = new BigUint64Array([BigInt(requiredProofSize)]);
      const publicSizeBuffer2 = new BigUint64Array([BigInt(requiredPublicSize)]);
      
      const result2 = lib.symbols.groth16_prover_prove(
        this.proverObject,
        ptr(witnessData),
        BigInt(witnessData.length),
        ptr(proofBuffer2),
        ptr(proofSizeBuffer2),
        ptr(publicBuffer2),
        ptr(publicSizeBuffer2),
        ptr(errorMsgBuffer),
        BigInt(errorMsgSize)
      );
      
      if (result2 !== PROVER_OK) {
        const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
        throw new Error(`Prover failed (retry): ${errorMsg || `error code ${result2}`}`);
      }
      
      const proofJson = new TextDecoder().decode(proofBuffer2.slice(0, Number(proofSizeBuffer2[0])));
      const publicJson = new TextDecoder().decode(publicBuffer2.slice(0, Number(publicSizeBuffer2[0])));
      
      return {
        proof: JSON.parse(proofJson),
        publicSignals: JSON.parse(publicJson),
      };
    }
    
    if (result !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`Prover failed: ${errorMsg || `error code ${result}`}`);
    }
    
    const actualProofSize = Number(proofSizeBuffer[0]);
    const actualPublicSize = Number(publicSizeBuffer[0]);
    
    const proofJson = new TextDecoder().decode(proofBuffer.slice(0, actualProofSize));
    const publicJson = new TextDecoder().decode(publicBuffer.slice(0, actualPublicSize));
    
    return {
      proof: JSON.parse(proofJson),
      publicSignals: JSON.parse(publicJson),
    };
  }

  destroy() {
    lib.symbols.groth16_prover_destroy(this.proverObject);
  }
}

// Stateful FileProver class - loads zkey from file path (no JS memory allocation)
export class FileProver {
  private proverObject: bigint;
  private proofSize: number;
  private publicSize: number;

  constructor(zkeyPath: string) {
    const errorMsgSize = 256;
    const errorMsgBuffer = new Uint8Array(errorMsgSize);
    const proverObjectBuffer = new BigUint64Array(1);
    const pathBuf = encoder(zkeyPath);

    const result = lib.symbols.groth16_prover_create_zkey_file(
      ptr(proverObjectBuffer),
      ptr(pathBuf),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize),
    );

    if (result !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`Failed to create file prover: ${errorMsg || `error code ${result}`}`);
    }

    this.proverObject = proverObjectBuffer[0]!;
    const sizes = getBufferSizesFromFile(zkeyPath);
    this.proofSize = sizes.proofSize;
    this.publicSize = sizes.publicSize;
  }

  prove(witnessData: Uint8Array): { proof: Groth16Proof; publicSignals: string[] } {
    const proofBuffer = new Uint8Array(this.proofSize);
    const publicBuffer = new Uint8Array(this.publicSize);
    const proofSizeBuffer = new BigUint64Array([BigInt(this.proofSize)]);
    const publicSizeBuffer = new BigUint64Array([BigInt(this.publicSize)]);
    const errorMsgSize = 256;
    const errorMsgBuffer = new Uint8Array(errorMsgSize);

    const result = lib.symbols.groth16_prover_prove(
      this.proverObject,
      ptr(witnessData),
      BigInt(witnessData.length),
      ptr(proofBuffer),
      ptr(proofSizeBuffer),
      ptr(publicBuffer),
      ptr(publicSizeBuffer),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize),
    );

    if (result === PROVER_ERROR_SHORT_BUFFER) {
      const requiredProofSize = Number(proofSizeBuffer[0]);
      const requiredPublicSize = Number(publicSizeBuffer[0]);

      const proofBuffer2 = new Uint8Array(requiredProofSize);
      const publicBuffer2 = new Uint8Array(requiredPublicSize);
      const proofSizeBuffer2 = new BigUint64Array([BigInt(requiredProofSize)]);
      const publicSizeBuffer2 = new BigUint64Array([BigInt(requiredPublicSize)]);

      const result2 = lib.symbols.groth16_prover_prove(
        this.proverObject,
        ptr(witnessData),
        BigInt(witnessData.length),
        ptr(proofBuffer2),
        ptr(proofSizeBuffer2),
        ptr(publicBuffer2),
        ptr(publicSizeBuffer2),
        ptr(errorMsgBuffer),
        BigInt(errorMsgSize),
      );

      if (result2 !== PROVER_OK) {
        const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
        throw new Error(`File prover failed (retry): ${errorMsg || `error code ${result2}`}`);
      }

      const proofJson = new TextDecoder().decode(proofBuffer2.slice(0, Number(proofSizeBuffer2[0])));
      const publicJson = new TextDecoder().decode(publicBuffer2.slice(0, Number(publicSizeBuffer2[0])));
      return { proof: JSON.parse(proofJson), publicSignals: JSON.parse(publicJson) };
    }

    if (result !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`File prover failed: ${errorMsg || `error code ${result}`}`);
    }

    const actualProofSize = Number(proofSizeBuffer[0]);
    const actualPublicSize = Number(publicSizeBuffer[0]);
    const proofJson = new TextDecoder().decode(proofBuffer.slice(0, actualProofSize));
    const publicJson = new TextDecoder().decode(publicBuffer.slice(0, actualPublicSize));
    return { proof: JSON.parse(proofJson), publicSignals: JSON.parse(publicJson) };
  }

  destroy() {
    lib.symbols.groth16_prover_destroy(this.proverObject);
  }
}

/**
 * Calculate required buffer sizes for proof and public signals.
 * (Implementation is the exported function above; kept as a single definition.)
 */
export function prove(
  zkeyData: Uint8Array,
  witnessData: Uint8Array
): { proof: Groth16Proof; publicSignals: string[] } {
  const { proofSize, publicSize } = getBufferSizes(zkeyData);
  
  // Allocate output buffers
  const proofBuffer = new Uint8Array(proofSize);
  const publicBuffer = new Uint8Array(publicSize);
  const proofSizeBuffer = new BigUint64Array([BigInt(proofSize)]);
  const publicSizeBuffer = new BigUint64Array([BigInt(publicSize)]);
  const errorMsgSize = 256;
  const errorMsgBuffer = new Uint8Array(errorMsgSize);
  
  // Call the prover
  const result = lib.symbols.groth16_prover(
    ptr(zkeyData),
    BigInt(zkeyData.length),
    ptr(witnessData),
    BigInt(witnessData.length),
    ptr(proofBuffer),
    ptr(proofSizeBuffer),
    ptr(publicBuffer),
    ptr(publicSizeBuffer),
    ptr(errorMsgBuffer),
    BigInt(errorMsgSize)
  );
  
  if (result === PROVER_ERROR_SHORT_BUFFER) {
    // Buffers were too small, try again with required sizes
    const requiredProofSize = Number(proofSizeBuffer[0]);
    const requiredPublicSize = Number(publicSizeBuffer[0]);
    
    const proofBuffer2 = new Uint8Array(requiredProofSize);
    const publicBuffer2 = new Uint8Array(requiredPublicSize);
    const proofSizeBuffer2 = new BigUint64Array([BigInt(requiredProofSize)]);
    const publicSizeBuffer2 = new BigUint64Array([BigInt(requiredPublicSize)]);
    
    const result2 = lib.symbols.groth16_prover(
      ptr(zkeyData),
      BigInt(zkeyData.length),
      ptr(witnessData),
      BigInt(witnessData.length),
      ptr(proofBuffer2),
      ptr(proofSizeBuffer2),
      ptr(publicBuffer2),
      ptr(publicSizeBuffer2),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize)
    );
    
    if (result2 !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`Prover failed (retry): ${errorMsg || `error code ${result2}`}`);
    }
    
    // Parse results
    const proofJson = new TextDecoder().decode(proofBuffer2.slice(0, Number(proofSizeBuffer2[0])));
    const publicJson = new TextDecoder().decode(publicBuffer2.slice(0, Number(publicSizeBuffer2[0])));
    
    return {
      proof: JSON.parse(proofJson),
      publicSignals: JSON.parse(publicJson),
    };
  }
  
  if (result !== PROVER_OK) {
    const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
    throw new Error(`Prover failed: ${errorMsg || `error code ${result}`}`);
  }
  
  // Parse results
  const actualProofSize = Number(proofSizeBuffer[0]);
  const actualPublicSize = Number(publicSizeBuffer[0]);
  
  const proofJson = new TextDecoder().decode(proofBuffer.slice(0, actualProofSize));
  const publicJson = new TextDecoder().decode(publicBuffer.slice(0, actualPublicSize));
  
  return {
    proof: JSON.parse(proofJson),
    publicSignals: JSON.parse(publicJson),
  };
}

/**
 * Verify a Groth16 proof using rapidsnark dylib via FFI
 */
export function verify(
  proof: object,
  publicSignals: string[],
  verificationKey: object | string,
): boolean {
  const encoder = new TextEncoder();
  const proofJson = JSON.stringify(proof) + '\0';
  const publicJson = JSON.stringify(publicSignals) + '\0';
  const proofBuf = encoder.encode(proofJson);
  const publicBuf = encoder.encode(publicJson);
  
  let vkBuf: Uint8Array;
  if (typeof verificationKey === 'string') {
    const vkContent = readFileSync(verificationKey, 'utf8');
    vkBuf = encoder.encode(vkContent + '\0');
  } else {
    vkBuf = encoder.encode(JSON.stringify(verificationKey) + '\0');
  }

  const errorMsgSize = 256;
  const errorMsgBuffer = new Uint8Array(errorMsgSize);

  const result = lib.symbols.groth16_verify(
    ptr(proofBuf),
    ptr(publicBuf),
    ptr(vkBuf),
    ptr(errorMsgBuffer),
    BigInt(errorMsgSize)
  );
  
  if (result === VERIFIER_VALID_PROOF) {
    return true;
  } else if (result === VERIFIER_INVALID_PROOF) {
    return false;
  } else {
    const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
    throw new Error(`Verifier error: ${errorMsg || `error code ${result}`}`);
  }
}

function encoder(str: string): Uint8Array {
  return new TextEncoder().encode(str + '\0');
}

function getBufferSizesFromFile(zkeyPath: string): { proofSize: number; publicSize: number } {
  const errorMsgSize = 256;
  const errorMsgBuffer = new Uint8Array(errorMsgSize);
  const pathBuf = encoder(zkeyPath);

  const publicSizeBuffer = new BigUint64Array(1);
  const publicSizeResult = lib.symbols.groth16_public_size_for_zkey_file(
    ptr(pathBuf),
    ptr(publicSizeBuffer),
    ptr(errorMsgBuffer),
    BigInt(errorMsgSize),
  );

  if (publicSizeResult !== PROVER_OK) {
    const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
    throw new Error(`Failed to get public size from file: ${errorMsg || `error code ${publicSizeResult}`}`);
  }

  const proofSizeBuffer = new BigUint64Array(1);
  lib.symbols.groth16_proof_size(ptr(proofSizeBuffer));

  const PROOF_MARGIN = 100;
  const PUBLIC_MARGIN = 100;
  return {
    proofSize: Number(proofSizeBuffer[0]) + PROOF_MARGIN,
    publicSize: Number(publicSizeBuffer[0]) + PUBLIC_MARGIN,
  };
}

export function proveFromFile(
  zkeyPath: string,
  witnessData: Uint8Array,
): { proof: Groth16Proof; publicSignals: string[] } {
  const { proofSize, publicSize } = getBufferSizesFromFile(zkeyPath);
  const pathBuf = encoder(zkeyPath);

  const proofBuffer = new Uint8Array(proofSize);
  const publicBuffer = new Uint8Array(publicSize);
  const proofSizeBuffer = new BigUint64Array([BigInt(proofSize)]);
  const publicSizeBuffer = new BigUint64Array([BigInt(publicSize)]);
  const errorMsgSize = 256;
  const errorMsgBuffer = new Uint8Array(errorMsgSize);

  const result = lib.symbols.groth16_prover_zkey_file(
    ptr(pathBuf),
    ptr(witnessData),
    BigInt(witnessData.length),
    ptr(proofBuffer),
    ptr(proofSizeBuffer),
    ptr(publicBuffer),
    ptr(publicSizeBuffer),
    ptr(errorMsgBuffer),
    BigInt(errorMsgSize),
  );

  if (result === PROVER_ERROR_SHORT_BUFFER) {
    const requiredProofSize = Number(proofSizeBuffer[0]);
    const requiredPublicSize = Number(publicSizeBuffer[0]);

    const proofBuffer2 = new Uint8Array(requiredProofSize);
    const publicBuffer2 = new Uint8Array(requiredPublicSize);
    const proofSizeBuffer2 = new BigUint64Array([BigInt(requiredProofSize)]);
    const publicSizeBuffer2 = new BigUint64Array([BigInt(requiredPublicSize)]);

    const result2 = lib.symbols.groth16_prover_zkey_file(
      ptr(pathBuf),
      ptr(witnessData),
      BigInt(witnessData.length),
      ptr(proofBuffer2),
      ptr(proofSizeBuffer2),
      ptr(publicBuffer2),
      ptr(publicSizeBuffer2),
      ptr(errorMsgBuffer),
      BigInt(errorMsgSize),
    );

    if (result2 !== PROVER_OK) {
      const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
      throw new Error(`Prover from file failed (retry): ${errorMsg || `error code ${result2}`}`);
    }

    const proofJson = new TextDecoder().decode(proofBuffer2.slice(0, Number(proofSizeBuffer2[0])));
    const publicJson = new TextDecoder().decode(publicBuffer2.slice(0, Number(publicSizeBuffer2[0])));
    return { proof: JSON.parse(proofJson), publicSignals: JSON.parse(publicJson) };
  }

  if (result !== PROVER_OK) {
    const errorMsg = new TextDecoder().decode(errorMsgBuffer).replace(/\0/g, '');
    throw new Error(`Prover from file failed: ${errorMsg || `error code ${result}`}`);
  }

  const actualProofSize = Number(proofSizeBuffer[0]);
  const actualPublicSize = Number(publicSizeBuffer[0]);
  const proofJson = new TextDecoder().decode(proofBuffer.slice(0, actualProofSize));
  const publicJson = new TextDecoder().decode(publicBuffer.slice(0, actualPublicSize));
  return { proof: JSON.parse(proofJson), publicSignals: JSON.parse(publicJson) };
}
