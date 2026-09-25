#!/usr/bin/env python3
"""Sanity-check the built wasm bundle before anyone downloads it.

This exists because a post-processing pass (wasm-opt from binaryen 108) once
rewrote the `__wbindgen_externrefs` export to point at the *funcref* table
instead of the externref one. That table is declared with max == initial, so
the first attempt to grow it failed and the client died on startup with:

    RangeError: WebAssembly.Table.grow(): failed to grow table by 4

Nothing in the build failed; the module was simply wrong. So the build now
checks the shape of what it produced rather than trusting the tools that made
it. Run against client/generated/solatel_sim_bg.wasm.
"""

import sys
from pathlib import Path

FUNCREF = 0x70
EXTERNREF = 0x6F
REFTYPE_NAMES = {FUNCREF: "funcref", EXTERNREF: "externref"}


def read_uleb(data: bytes, offset: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, offset
        shift += 7


def parse(path: Path) -> tuple[list, list]:
    data = path.read_bytes()
    if data[:4] != b"\x00asm":
        raise ValueError(f"{path} is not a WebAssembly module")

    offset = 8
    tables: list[tuple[int, int, int | None]] = []
    table_exports: list[tuple[str, int]] = []

    while offset < len(data):
        section_id = data[offset]
        offset += 1
        size, offset = read_uleb(data, offset)
        end = offset + size

        if section_id == 4:  # tables
            count, cursor = read_uleb(data, offset)
            for _ in range(count):
                reftype = data[cursor]
                cursor += 1
                flags = data[cursor]
                cursor += 1
                initial, cursor = read_uleb(data, cursor)
                maximum = None
                if flags & 0x01:
                    maximum, cursor = read_uleb(data, cursor)
                tables.append((reftype, initial, maximum))

        elif section_id == 7:  # exports
            count, cursor = read_uleb(data, offset)
            for _ in range(count):
                length, cursor = read_uleb(data, cursor)
                name = data[cursor : cursor + length].decode("utf-8", "replace")
                cursor += length
                kind = data[cursor]
                cursor += 1
                index, cursor = read_uleb(data, cursor)
                if kind == 1:
                    table_exports.append((name, index))

        offset = end

    return tables, table_exports


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "web/dist/solatel_client_bg.wasm")
    if not path.exists():
        print(f"check-wasm: {path} does not exist", file=sys.stderr)
        return 1

    tables, table_exports = parse(path)
    problems = []

    if not table_exports:
        problems.append("the module exports no tables; wasm-bindgen output should export one")

    for name, index in table_exports:
        if index >= len(tables):
            problems.append(f"{name} refers to table {index}, but only {len(tables)} exist")
            continue

        reftype, initial, maximum = tables[index]
        kind = REFTYPE_NAMES.get(reftype, hex(reftype))

        if name == "__wbindgen_externrefs":
            if reftype != EXTERNREF:
                problems.append(
                    f"{name} points at table {index}, which is a {kind} table, not externref"
                )
            if maximum is not None and maximum <= initial:
                problems.append(
                    f"{name} points at a table that cannot grow "
                    f"(initial={initial}, max={maximum}); the client will fail on startup"
                )

    if problems:
        print(f"check-wasm: {path} is not usable", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(f"  tables: {[(REFTYPE_NAMES.get(t, hex(t)), i, m) for t, i, m in tables]}",
              file=sys.stderr)
        return 1

    summary = ", ".join(
        f"{name} -> {REFTYPE_NAMES.get(tables[i][0], '?')}" for name, i in table_exports
    )
    size_mb = path.stat().st_size // 1048576
    print(f">> wasm checks out ({size_mb} MB, {summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
