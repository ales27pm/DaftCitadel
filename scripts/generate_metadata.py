#!/usr/bin/env python3
"""Utility to generate Daft Citadel installer metadata using robust JSON handling."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import sys
from typing import Iterable, List


def parse_bool(value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in {"true", "1", "yes", "y"}:
        return True
    if lowered in {"false", "0", "no", "n", ""}:
        return False
    raise ValueError(f"Unsupported boolean value: {value!r}")


def dedupe_preserve_order(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    ordered: List[str] = []
    for value in values:
        if value is None:
            continue
        if value == "":
            continue
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def decode_modules(encoded: str) -> List[str]:
    if not encoded:
        return []
    try:
        decoded = base64.b64decode(encoded.encode("utf-8"))
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"Invalid base64 payload for plugin modules: {exc}") from exc
    text = decoded.decode("utf-8")
    modules = [item for item in text.splitlines() if item]
    return dedupe_preserve_order(modules)


def ensure_parent(path: str) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)


def write_json(path: str, payload: object) -> None:
    ensure_parent(path)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-manifest-out", required=True)
    parser.add_argument("--plugin-hints-out", required=True)
    parser.add_argument("--profile-manifest-version", type=int, required=True)
    parser.add_argument("--plugin-hints-version", type=int, required=True)
    parser.add_argument("--manifest-generated-at", required=True)
    parser.add_argument("--plugin-hints-generated-at", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--profile-name", required=True)
    parser.add_argument("--base-path", required=True)
    parser.add_argument("--log-path", required=True)
    parser.add_argument("--plugin-cache-path", required=True)
    parser.add_argument("--plugin-cache-hints-path", required=True)
    parser.add_argument("--feature-ai", required=True)
    parser.add_argument("--feature-gui", required=True)
    parser.add_argument("--feature-expanded-synths", required=True)
    parser.add_argument("--feature-heavy-assets", required=True)
    parser.add_argument("--feature-groove-tools", required=True)
    parser.add_argument("--feature-experimental-synths", required=True)
    parser.add_argument("--feature-container", required=True)
    parser.add_argument("--module-enabled-override", action="append", default=[])
    parser.add_argument("--module-disabled-override", action="append", default=[])
    parser.add_argument("--plugin-hint-format", action="append", default=[])
    parser.add_argument("--plugin-hint-identifier", action="append", default=[])
    parser.add_argument("--plugin-hint-name", action="append", default=[])
    parser.add_argument("--plugin-hint-binary-path", action="append", default=[])
    parser.add_argument("--plugin-hint-cache-path", action="append", default=[])
    parser.add_argument("--plugin-hint-enabled", action="append", default=[])
    parser.add_argument("--plugin-hint-available", action="append", default=[])
    parser.add_argument("--plugin-hint-version", action="append", default=[])
    parser.add_argument("--plugin-hint-modules", action="append", default=[])
    return parser


def build_profile_manifest(args: argparse.Namespace) -> dict:
    return {
        "version": args.profile_manifest_version,
        "generatedAt": args.manifest_generated_at,
        "profile": args.profile,
        "profileName": args.profile_name,
        "features": {
            "ai": parse_bool(args.feature_ai),
            "gui": parse_bool(args.feature_gui),
            "expandedSynths": parse_bool(args.feature_expanded_synths),
            "heavyAssets": parse_bool(args.feature_heavy_assets),
            "grooveTools": parse_bool(args.feature_groove_tools),
            "experimentalSynths": parse_bool(args.feature_experimental_synths),
            "container": parse_bool(args.feature_container),
        },
        "paths": {
            "base": args.base_path,
            "log": args.log_path,
            "pluginCache": args.plugin_cache_path,
            "pluginCacheHints": args.plugin_cache_hints_path,
        },
        "modules": {
            "enabledOverrides": dedupe_preserve_order(args.module_enabled_override),
            "disabledOverrides": dedupe_preserve_order(args.module_disabled_override),
        },
    }


def build_plugin_hints(args: argparse.Namespace) -> List[dict]:
    lengths = {
        len(args.plugin_hint_format),
        len(args.plugin_hint_identifier),
        len(args.plugin_hint_name),
        len(args.plugin_hint_binary_path),
        len(args.plugin_hint_cache_path),
        len(args.plugin_hint_enabled),
        len(args.plugin_hint_available),
        len(args.plugin_hint_version),
        len(args.plugin_hint_modules),
    }

    lengths.discard(0)
    if not lengths:
        return []
    if len(lengths) != 1:
        raise ValueError("Inconsistent plugin hint argument counts")

    plugin_hints: List[dict] = []
    for idx in range(lengths.pop()):
        modules = decode_modules(args.plugin_hint_modules[idx])
        hint = {
            "format": args.plugin_hint_format[idx],
            "identifier": args.plugin_hint_identifier[idx],
            "name": args.plugin_hint_name[idx],
            "binaryPath": args.plugin_hint_binary_path[idx],
            "cachePath": args.plugin_hint_cache_path[idx],
            "enabled": parse_bool(args.plugin_hint_enabled[idx]),
            "available": parse_bool(args.plugin_hint_available[idx]),
            "modules": modules,
        }
        version_value = args.plugin_hint_version[idx].strip()
        if version_value:
            hint["version"] = version_value
        plugin_hints.append(hint)
    return plugin_hints


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        profile_manifest = build_profile_manifest(args)
        plugin_hints = {
            "version": args.plugin_hints_version,
            "generatedAt": args.plugin_hints_generated_at,
            "hints": build_plugin_hints(args),
        }
    except ValueError as exc:
        print(f"[generate_metadata] {exc}", file=sys.stderr)
        return 1

    write_json(args.profile_manifest_out, profile_manifest)
    write_json(args.plugin_hints_out, plugin_hints)
    return 0


if __name__ == "__main__":
    sys.exit(main())
