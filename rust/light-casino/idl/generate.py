#!/usr/bin/env python3
"""Write the pinocchio-idl annotation module, then patch the generated IDL.

pinocchio-idl's instruction id is a single byte. This program's dispatcher
matches sha256("global:<name>")[..8], so `fix` copies those sighashes onto the
instructions the tool emitted. It also restores Borsh layouts the tool rewrites
(`[u8; 32]` becomes `pubkey`) and marks optional accounts the tool cannot express.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "programs" / "light-casino" / "src"
DISPATCH = SRC / "dispatch.rs"
LOAD = SRC / "light_casino" / "load.rs"
ANNOTATION = SRC / "pinocchio_idl.rs"
IDL = ROOT / "idl" / "light_casino.json"

PROGRAM_ID = "Casinog7X7VCFahCyYLDPMTmX3T7LYQHbm8dQuQWKXnf"

# Instruction-data types that are not #[p_state] accounts.
EXTRA_TYPES = {
    "CompressedProof": {
        "kind": "struct",
        "fields": [
            {"name": "a", "type": {"array": ["u8", 32]}},
            {"name": "b", "type": {"array": ["u8", 64]}},
            {"name": "c", "type": {"array": ["u8", 32]}},
        ],
    },
    "PackedStateTreeInfo": {
        "kind": "struct",
        "fields": [
            {"name": "root_index", "type": "u16"},
            {"name": "prove_by_index", "type": "bool"},
            {"name": "merkle_tree_pubkey_index", "type": "u8"},
            {"name": "queue_pubkey_index", "type": "u8"},
            {"name": "leaf_index", "type": "u32"},
        ],
    },
    "LightAddressTreeInfo": {
        "kind": "struct",
        "fields": [
            {"name": "address_merkle_tree_pubkey_index", "type": "u8"},
            {"name": "address_queue_pubkey_index", "type": "u8"},
            {"name": "root_index", "type": "u16"},
        ],
    },
    "LightCompressedAccountMeta": {
        "kind": "struct",
        "fields": [
            {
                "name": "tree_info",
                "type": {"defined": {"name": "PackedStateTreeInfo"}},
            },
            {"name": "address", "type": {"array": ["u8", 32]}},
            {"name": "output_state_tree_index", "type": "u8"},
        ],
    },
}

# Borsh newtype: one unnamed Option<CompressedProof>.
LIGHT_VALIDITY_PROOF = {
    "kind": "struct",
    "fields": [
        {"option": {"defined": {"name": "CompressedProof"}}},
    ],
}

NOT_ACCOUNTS = {"UncompressedProof"}


def sighash(name: str) -> list[int]:
    return list(hashlib.sha256(f"global:{name}".encode()).digest()[:8])


def rust_to_idl(ty: str):
    ty = re.sub(r"\s+", "", ty)
    ty = ty.replace("REGISTER_PUBLIC_INPUTS", "6")
    if ty in {"u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "bool", "string"}:
        return ty
    if ty == "Pubkey":
        return "pubkey"
    if ty == "Vec<u8>":
        return "bytes"
    if ty.startswith("Vec<") and ty.endswith(">"):
        return {"vec": rust_to_idl(ty[4:-1])}
    if ty.startswith("Option<") and ty.endswith(">"):
        return {"option": rust_to_idl(ty[7:-1])}
    match = re.fullmatch(r"\[(.+);(\d+)\]", ty)
    if match:
        return {"array": [rust_to_idl(match.group(1)), int(match.group(2))]}
    if ty == "LightValidityProof":
        return {"defined": {"name": "LightValidityProof"}}
    return {"defined": {"name": ty}}


def parse_instructions():
    dispatch = DISPATCH.read_text()
    load = LOAD.read_text()
    blocks = re.split(r"\nfn ix_", dispatch)[1:]
    loaders = {}
    parts = re.split(r"\nimpl<'info> (\w+)<'info>", load)[1:]
    for i in range(0, len(parts), 2):
        name, body = parts[i], parts[i + 1]
        fields = []
        for line in body.splitlines():
            match = re.match(r"\s+let (\w+) = ix\.(\w+)(.*);", line)
            if not match:
                continue
            field, kind, rest = match.group(1), match.group(2), match.group(3)
            if kind in {"rest", "bumps"}:
                continue
            state = None
            state_match = re.search(r"::<(\w+)>", rest)
            if state_match and kind in {"load", "init", "init_unchecked", "optional_load"}:
                state = state_match.group(1)
            writable = False
            optional = kind.startswith("optional")
            signer = kind == "signer"
            if kind == "signer":
                writable = rest.strip().startswith("(true")
            elif kind == "load":
                writable = "true" in rest
            elif kind == "optional_load":
                writable = re.search(r",\s*true\s*\)", rest) is not None
            elif kind in {"init", "init_unchecked"}:
                writable = True
            elif kind == "optional":
                writable = "true" in rest
            elif kind == "unchecked":
                writable = rest.strip().startswith("(true")
            fields.append(
                {
                    "name": field,
                    "writable": writable,
                    "signer": signer,
                    "optional": optional,
                    "state": state,
                }
            )
        loaders[name] = fields

    instructions = []
    for block in blocks:
        name = block.split("(", 1)[0]
        struct = re.search(r"let ctx = (\w+)::load", block).group(1)
        args = re.findall(r"let (\w+) = take::<(.+?)>\(&mut data\)\?;", block)
        instructions.append({"name": name, "accounts": loaders[struct], "args": args})
    return instructions


def account_expr(account: dict) -> str:
    parts = []
    if account["writable"]:
        parts.append("mut")
    if account["signer"]:
        parts.append("signer")
    if account["state"]:
        parts.append(f"state = {account['state']}")
    if not parts:
        return account["name"]
    return f"{account['name']}({', '.join(parts)})"


def arg_ty(ty: str) -> str:
    return ty.replace("REGISTER_PUBLIC_INPUTS", "6")


def write_annotations() -> None:
    instructions = parse_instructions()
    lines = [
        "//! Annotation surface for `pinocchio-idl`.",
        "//!",
        "//! These functions are not the instruction handlers. `dispatch.rs` still",
        "//! matches the 8-byte sighash. `idl/generate.py fix` copies those sighashes",
        "//! onto the IDL, because pinocchio-idl's `id` is a single byte.",
        "",
        "#![allow(unused_variables)]",
        "",
        "use pinocchio_idl_macros::p_instruction;",
        "",
        "macro_rules! declare_id {",
        "    ($id:literal) => {};",
        "}",
        "",
        f'declare_id!("{PROGRAM_ID}");',
        "",
    ]
    for index, ix in enumerate(instructions):
        accounts = ",\n        ".join(account_expr(account) for account in ix["accounts"])
        lines.append("#[allow(dead_code)]")
        lines.append("#[p_instruction(")
        lines.append(f"    id = {index},")
        lines.append("    accounts = [")
        lines.append(f"        {accounts}")
        lines.append("    ],")
        if ix["args"]:
            args = ",\n        ".join(f"{name}: {arg_ty(ty)}" for name, ty in ix["args"])
            lines.append("    data = [")
            lines.append(f"        {args}")
            lines.append("    ]")
        lines.append(")]")
        lines.append(f"pub fn {ix['name']}(accounts: &[u8]) {{}}")
        lines.append("")
    ANNOTATION.write_text("\n".join(lines))
    print(f"wrote {ANNOTATION} ({len(instructions)} instructions)")


def struct_fields(source: str, name: str):
    match = re.search(rf"pub struct {name}\s*\{{", source)
    if not match:
        return None
    start = match.end()
    depth = 1
    i = start
    while i < len(source) and depth:
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
        i += 1
    body = source[start : i - 1]
    return re.findall(r"pub (\w+)\s*:\s*([^,\n]+)", body)


def collect_rust_fields() -> dict[str, list[tuple[str, str]]]:
    texts = []
    for path in SRC.rglob("*.rs"):
        texts.append(path.read_text())
    blob = "\n".join(texts)
    found = {}
    for name in re.findall(r"#\[p_state\]\s*(?:#\[[^\]]+\]\s*)*pub struct (\w+)", blob):
        fields = struct_fields(blob, name)
        if fields is not None:
            found[name] = [(field, ty.strip()) for field, ty in fields]
    return found


def fix(previous: Path | None) -> None:
    idl = json.loads(IDL.read_text())
    old = json.loads(previous.read_text()) if previous and previous.exists() else None
    old_ix = {ix["name"]: ix for ix in old["instructions"]} if old else {}
    instructions = {ix["name"]: ix for ix in parse_instructions()}
    rust_fields = collect_rust_fields()

    idl["address"] = PROGRAM_ID
    idl["metadata"]["description"] = (
        "Generated by pinocchio-idl from programs/light-casino/src. "
        "Instruction discriminators are sha256(\"global:<name>\")[..8], matching dispatch.rs. "
        "pinocchio-idl's id is a single byte, so generate.py restores those sighashes."
    )

    for ix in idl["instructions"]:
        ix["discriminator"] = sighash(ix["name"])
        parsed = instructions[ix["name"]]
        by_name = {account["name"]: account for account in parsed["accounts"]}
        previous_accounts = {
            account["name"]: account for account in old_ix.get(ix["name"], {}).get("accounts", [])
        }
        if ix["name"] in old_ix and "docs" in old_ix[ix["name"]]:
            ix["docs"] = old_ix[ix["name"]]["docs"]
        arg_types = {name: rust_to_idl(ty) for name, ty in parsed["args"]}
        if not ix.get("args"):
            # Zero-argument instructions come out of pinocchio-idl as null.
            # Anchor's BorshInstructionCoder requires an array.
            ix["args"] = []
        for arg in ix["args"]:
            if arg["name"] in arg_types:
                arg["type"] = arg_types[arg["name"]]
        for account in ix["accounts"]:
            account.pop("state", None)
            meta = by_name.get(account["name"])
            if meta and meta["optional"]:
                account["optional"] = True
            previous_account = previous_accounts.get(account["name"])
            if previous_account and "pda" in previous_account:
                account["pda"] = previous_account["pda"]
            if previous_account and "docs" in previous_account:
                account["docs"] = previous_account["docs"]

    types = {ty["name"]: ty for ty in idl["types"]}
    for name, fields in rust_fields.items():
        if name not in types:
            continue
        idl_fields = types[name]["type"]["fields"]
        by_name = {field["name"]: field for field in idl_fields}
        for field_name, rust_ty in fields:
            if field_name in by_name:
                by_name[field_name]["type"] = rust_to_idl(rust_ty)

    for name, body in EXTRA_TYPES.items():
        types[name] = {"name": name, "type": body}
    types["LightValidityProof"] = {"name": "LightValidityProof", "type": LIGHT_VALIDITY_PROOF}

    idl["accounts"] = [account for account in idl["accounts"] if account["name"] not in NOT_ACCOUNTS]
    if old:
        old_errors = {err["name"]: err for err in old.get("errors", [])}
        for err in idl["errors"]:
            previous = old_errors.get(err["name"])
            if previous and previous.get("msg"):
                err["msg"] = previous["msg"]
        for event in old.get("events", []):
            if event["name"] not in types:
                previous = next((ty for ty in old["types"] if ty["name"] == event["name"]), None)
                if previous:
                    types[event["name"]] = previous
        idl["events"] = old.get("events", [])
    idl["types"] = [types[name] for name in sorted(types)]

    IDL.write_text(json.dumps(idl, indent=2, ensure_ascii=False) + "\n")
    print(f"patched {IDL}")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "annotations"
    if command == "annotations":
        write_annotations()
    elif command == "fix":
        previous = Path(sys.argv[2]) if len(sys.argv) > 2 else None
        fix(previous)
    else:
        raise SystemExit(f"unknown command {command}")


if __name__ == "__main__":
    main()
