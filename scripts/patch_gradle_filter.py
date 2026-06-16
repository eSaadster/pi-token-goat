"""Apply enhanced GradleFilter patch to bash_compress.py via line-number splice."""
from __future__ import annotations

import sys
from pathlib import Path

SRC = Path("src/token_goat/bash_compress.py")
FRAGMENT = Path("scripts/gradle_section.py.fragment")


def main() -> int:
    raw = SRC.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)

    # Find "# --- Gradle ---" section start (0-indexed)
    gradle_start = None
    for i, line in enumerate(lines):
        if line.strip().startswith("# --- Gradle ---"):
            gradle_start = i
            break
    if gradle_start is None:
        print("ERROR: could not find '# --- Gradle ---' marker", file=sys.stderr)
        return 1

    # Find the class that follows GradleFilter (AntFilter)
    ant_start = None
    for i in range(gradle_start + 1, len(lines)):
        if lines[i].startswith("class AntFilter"):
            ant_start = i
            break
    if ant_start is None:
        print("ERROR: could not find 'class AntFilter'", file=sys.stderr)
        return 1

    # Sanity check
    section_text = "".join(lines[gradle_start:ant_start])
    if "class GradleFilter" not in section_text:
        print("ERROR: GradleFilter not found in expected range", file=sys.stderr)
        return 1

    print(f"Replacing lines {gradle_start + 1}-{ant_start} ({ant_start - gradle_start} lines)")

    new_section = FRAGMENT.read_text(encoding="utf-8")
    new_lines = lines[:gradle_start] + [new_section] + lines[ant_start:]
    SRC.write_text("".join(new_lines), encoding="utf-8")
    print(f"Patched {SRC} successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
