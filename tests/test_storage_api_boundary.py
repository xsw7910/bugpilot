"""The storage API boundary: what production code may know of BugPilot's unified data folder (0.1.6 Batch 2A).

The rule: every path under the data root comes from a checked method of
``bugpilot.core.storage`` — one that refuses links, a data root inside the
repository or a Git working tree, a foreign identity record and, for
credentials, a place that is not private. These tests keep production code on
that path, as far as a source scan can:

1. Only approved consumers import ``storage``. Batch 2B adds each consumer to
   ``APPROVED_IMPORTERS`` as it switches, in the same commit, with the reason;
   Batch 2B-2 (global configuration) added the first five. Request scopes are
   opened only by the entry points, the CLI and the MCP server (D-8).
2. ``private_folder`` is used by ``storage`` alone.
3. Outside ``storage.py`` no production module touches storage's private
   fields or helpers.
4. Outside ``storage.py`` no production module spells the new layout itself.
5. The storage objects expose no folder as a public field.
6. ``diagnostics()`` gives paths as text and creates nothing.

The 0.1.5 locations the legacy consumers still use are the path-literal
ratchet's job (``tests/test_storage_inventory.py``), which also proves those
consumers are unchanged until Batch 2B moves them.

**Limits of a static scan, stated.** It sees names as written, not computed
ones (``getattr`` with a built string, a path joined from pieces, a path
handed over by another module), and it does not see what a caller does with a
path a checked method returned. Batch 2B's end-to-end write witness checks
that behaviour. Comments and docstrings are not scanned: a mention is not a use.
"""

from __future__ import annotations

import ast
import dataclasses
import os
from pathlib import Path

import pytest

from bugpilot.core import storage
from bugpilot.core.storage import GlobalStorage, RepositoryStorage, data_root, global_storage, repository_storage

REPO = Path(__file__).resolve().parents[1]
PRODUCT = REPO / "bugpilot"
STORAGE = PRODUCT / "core" / "storage.py"
PRIVATE_FOLDER = PRODUCT / "core" / "private_folder.py"

#: Production modules allowed to import ``bugpilot.core.storage``, each with its reason (plan §14.3, D-8).
APPROVED_IMPORTERS: dict[str, str] = {
    "bugpilot/core/user_config.py": "Batch 2B-2: config.toml through config_file() and write_config_file()",
    "bugpilot/core/instructions.py": "Batch 2B-2: user instructions through user_instructions_file()",
    "bugpilot/core/fix_mode_store.py": "Batch 2B-2: user Fix Modes through user_fix_modes_dir()",
    "bugpilot/cli.py": "Batch 2B-2: one request scope per command",
    "bugpilot/mcp_server.py": "Batch 2B-2: one request scope per tool call",
    "bugpilot/core/repository_settings.py": (
        "Batch 2B-3a: project settings through the repository-storage chokepoint, settings_file() and fix_modes_dir()"
    ),
    "bugpilot/core/config.py": (
        "0.1.7: work items and memory through work_item_dir() and memory_file(); the readers' base through check(); "
        "attachments through attachments_dir() (ST-1); an agent's work folder through check_private_for_agent() (S-2)"
    ),
    "bugpilot/core/cleanup.py": "0.1.7: clean and bug --fresh through remove_work_item() and remove_memory_file()",
    "bugpilot/core/doctor.py": "0.1.7: doctor's storage object from diagnostics(), check() and privacy() (S-2)",
}
#: The only production modules that may open a request scope: the entry points (D-8).
SCOPE_OPENERS = frozenset({"bugpilot/cli.py", "bugpilot/mcp_server.py"})
#: Storage's private fields and the private helpers no other module may reach for.
PRIVATE_NAMES = frozenset({"_data_root", "_directory", "_config_dir", "_record_file"})
#: Strings that spell the unified layout or its controls; only ``storage.py`` may hold them.
LAYOUT_STRINGS = frozenset({"repositories", "repository.json", "BUGPILOT_HOME", "GIT_WORK_TREE"})


def _modules() -> dict[str, ast.Module]:
    return {
        path.relative_to(REPO).as_posix(): ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for path in sorted(PRODUCT.rglob("*.py"))
    }


def _imports_of(tree: ast.Module, module_path: str) -> set[str]:
    """Every module an ``import`` statement names, relative imports resolved within the package."""
    package = module_path.removesuffix(".py").replace("/", ".").rsplit(".", 1)[0]
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".")
                base = base[: len(base) - (node.level - 1)]
                prefix = ".".join(base)
                target = f"{prefix}.{node.module}" if node.module else prefix
            else:
                target = node.module or ""
            found.add(target)
            found.update(f"{target}.{alias.name}" for alias in node.names)
    return found


def _strings_outside_docstrings(tree: ast.Module) -> set[str]:
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings
    }


def test_only_the_batch_2b2_consumers_import_the_foundation():
    """Each Batch 2B consumer is approved here by name; any other import of storage is a path built around it."""
    importers = sorted(
        path
        for path, tree in _modules().items()
        if path not in ("bugpilot/core/storage.py",)
        and any(name == "bugpilot.core.storage" or name.startswith("bugpilot.core.storage.")
                for name in _imports_of(tree, path))
    )
    assert importers == sorted(APPROVED_IMPORTERS), importers


def _scope_references(tree: ast.Module) -> list[int]:
    """Lines that name ``request_scope``: an attribute, a bare name, or an import of it."""
    lines = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "request_scope":
            lines.append(node.lineno)
        elif isinstance(node, ast.Name) and node.id == "request_scope":
            lines.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and any(alias.name == "request_scope" for alias in node.names):
            lines.append(node.lineno)
    return lines


def test_request_scopes_are_opened_only_by_the_entry_points():
    """A scope bounds one request (C-2); a consumer that opened its own could outlive or split one."""
    openers = sorted(
        path for path, tree in _modules().items()
        if path != "bugpilot/core/storage.py" and _scope_references(tree)
    )
    assert openers == sorted(SCOPE_OPENERS), openers


def test_the_error_vocabulary_stays_a_leaf():
    """``errors`` holds the storage-unavailable carrier, but knows nothing of storage itself (C-1, M-1)."""
    tree = _modules()["bugpilot/core/errors.py"]
    assert not any(name.startswith("bugpilot.core.storage") for name in _imports_of(tree, "bugpilot/core/errors.py"))


def test_private_folder_is_used_by_storage_alone():
    users = sorted(
        path
        for path, tree in _modules().items()
        if path not in ("bugpilot/core/private_folder.py",)
        and any(name.startswith("bugpilot.core.private_folder") for name in _imports_of(tree, path))
    )
    assert users == ["bugpilot/core/storage.py"], users


def test_no_production_module_reaches_into_storage():
    """No attribute named like storage's private fields, and no ``storage._helper``, outside storage.py."""
    offenders = []
    for path, tree in _modules().items():
        if path == "bugpilot/core/storage.py":
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                if node.attr in PRIVATE_NAMES:
                    offenders.append(f"{path}:{node.lineno} .{node.attr}")
                if node.attr.startswith("_") and isinstance(node.value, ast.Name) and node.value.id == "storage":
                    offenders.append(f"{path}:{node.lineno} storage.{node.attr}")
            if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("storage"):
                offenders.extend(f"{path}:{node.lineno} import {alias.name}" for alias in node.names
                                 if alias.name.startswith("_"))
    assert offenders == [], offenders


def test_no_production_module_spells_the_unified_layout():
    """The layout's names and controls live in storage.py alone; any other spelling is a path built by hand."""
    offenders = sorted(
        f"{path}: {text!r}"
        for path, tree in _modules().items()
        if path != "bugpilot/core/storage.py"
        for text in _strings_outside_docstrings(tree) & LAYOUT_STRINGS
    )
    assert offenders == [], offenders


@pytest.mark.parametrize("cls", [GlobalStorage, RepositoryStorage])
def test_the_storage_objects_expose_no_folder(cls):
    public = [field.name for field in dataclasses.fields(cls) if not field.name.startswith("_")]
    assert public == (["identity"] if cls is RepositoryStorage else []), public


def test_the_checked_methods_are_the_way_in():
    """What a caller may use instead of the private folders: one method per kind of place."""
    for name in ("ensure_config_dir", "config_file", "write_config_file", "user_instructions_file",
                 "user_fix_modes_dir", "diagnostics"):
        assert callable(getattr(GlobalStorage, name)), name
    for name in ("ensure", "record_state", "work_item_dir", "attachments_dir", "memory_file", "settings_file",
                 "fix_modes_dir", "work_items", "diagnostics"):
        assert callable(getattr(RepositoryStorage, name)), name


def test_diagnostics_return_text_and_create_nothing(tmp_path):
    repo = tmp_path / "checkout"
    repo.mkdir()
    assert not os.path.lexists(data_root())
    for found in (repository_storage(repo).diagnostics(), global_storage().diagnostics()):
        assert found and all(isinstance(value, str) and value for value in found.values())
        assert all(os.path.isabs(found[key]) for key in found if key in ("data_root", "config_dir", "repository_dir"))
    assert not os.path.lexists(data_root())
    assert sorted(os.listdir(repo)) == []


def test_this_scan_bites():
    """The scanners themselves find what they look for, so an empty result means something."""
    tree = ast.parse(
        "from bugpilot.core import storage\n"
        "from .storage import _directory\n"
        "x = storage._existing\n"
        "y = ns._data_root / 'repositories'\n"
    )
    assert "bugpilot.core.storage" in _imports_of(tree, "bugpilot/core/consumer.py")
    assert "bugpilot.core.storage._directory" in _imports_of(tree, "bugpilot/core/consumer.py")
    assert "repositories" in _strings_outside_docstrings(tree) & LAYOUT_STRINGS
    attributes = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    assert {"_existing", "_data_root"} <= attributes
    assert storage.__name__ == "bugpilot.core.storage"
    scoped = ast.parse(
        "from bugpilot.core.storage import request_scope\n"
        "with storage.request_scope():\n    pass\n"
        "with request_scope():\n    pass\n"
    )
    assert sorted(_scope_references(scoped)) == [1, 2, 4]
