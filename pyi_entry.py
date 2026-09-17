"""PyInstaller entry point for the standalone `bugpilot` executable.

Kept as a top-level script with an absolute import so PyInstaller can bundle it
directly (bugpilot/__main__.py uses a package-relative import that doesn't work as
a PyInstaller entry script).

Build (from the repo root, with any Python 3.10+ that has pip):

    python -m pip install --user pyinstaller
    python -m PyInstaller --onefile --name bugpilot --collect-submodules bugpilot --paths . pyi_entry.py

Output: dist/bugpilot.exe — self-contained, no Python required on the target.
"""

from bugpilot.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
