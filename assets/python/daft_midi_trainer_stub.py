#!/usr/bin/env python3
"""Stub trainer for profiles without AI support."""
import sys


def main() -> None:
    print("Daft Citadel AI features are disabled for this profile.")
    print("Re-run the installer with --profile=hybrid or --profile=citadel to enable them.")
    if sys.argv[1:]:
        print("Arguments received:", " ".join(sys.argv[1:]))


if __name__ == "__main__":
    main()
