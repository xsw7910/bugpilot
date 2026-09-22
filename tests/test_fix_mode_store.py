"""Custom Fix Modes on disk: what may be stored, and what may be done to it.

Two rules run through every test here.

**A file describes a mode; it does not declare its own authority.** Scope comes
from the directory, never from the JSON, so nothing on disk can claim to be a
built-in or to be more trusted than where it lives. Built-in ids are reserved
everywhere — loading, creating, duplicating, updating — because a developer who
could write `standard.json` could silently replace the workflow every other
developer's runs default to.

**Management and execution ask different questions.** Execution needs one
definition per id (project over user); management needs every physical file,
including the one that is currently shadowed, or the shadowed one could never be
edited or deleted again.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot.core.fix_mode_store import (
    BUILTIN_FIX_MODE_IDS,
    FixModeStore,
    catalog_for,
    custom_mode_payload,
    effective_registry_for,
)
from bugpilot.core.fix_modes import FixModeError, FixModeNotFoundError, builtin_fix_mode_registry

BUILTIN = builtin_fix_mode_registry()


@pytest.fixture
def home(tmp_path: Path) -> Path:
    return tmp_path / "home"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    return root


@pytest.fixture
def store(repo: Path, home: Path) -> FixModeStore:
    return FixModeStore(repo, home)


def definition(mode_id: str = "my-safe", **overrides) -> dict:
    """A complete custom definition, the shape a file carries."""
    payload = custom_mode_payload(BUILTIN.default)
    payload["id"] = mode_id
    payload["name"] = "My Safe Fix"
    payload.update(overrides)
    return payload


def write_mode(directory: Path, payload: dict, *, name: str | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (name or f"{payload['id']}.json")
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# --- where modes live --------------------------------------------------------


def test_scopes_are_two_directories_and_nothing_is_created_by_reading(store, home, repo):
    assert store.scope_dir("user") == home / "fix_modes"
    assert store.scope_dir("project") == repo / ".bugpilot" / "fix_modes"

    catalog = store.load_catalog()

    assert [mode.id for mode in catalog.builtin] == [mode.id for mode in BUILTIN.list_modes()]
    assert catalog.user == ()
    assert catalog.project == ()
    # Listing must not litter a repository with directories nobody asked for.
    assert not (repo / ".bugpilot").exists()
    assert not (home / "fix_modes").exists()


def test_project_scope_needs_a_repository(home):
    store = FixModeStore(None, home)

    with pytest.raises(FixModeError, match="Project Fix Modes need a repository"):
        store.scope_dir("project")
    # And a run outside a repository still gets built-ins and user modes.
    assert store.load_catalog().project == ()


def test_an_unknown_scope_is_refused(store):
    with pytest.raises(FixModeError, match="Unknown Fix Mode scope"):
        store.scope_dir("builtin")


def test_source_comes_from_the_directory_not_the_file(store, home, repo):
    write_mode(home / "fix_modes", definition("mine"))
    write_mode(repo / ".bugpilot" / "fix_modes", definition("theirs"))

    catalog = store.load_catalog()

    assert [(mode.id, mode.source) for mode in catalog.user] == [("mine", "user")]
    assert [(mode.id, mode.source) for mode in catalog.project] == [("theirs", "project")]


def test_a_file_cannot_claim_a_source(store, home):
    write_mode(home / "fix_modes", {**definition("forged"), "source": "builtin"})

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert "must not set 'source'" in catalog.issues[0].message


# --- the schema --------------------------------------------------------------


def test_malformed_json_is_reported_with_its_path_and_does_not_hide_the_others(store, home):
    directory = home / "fix_modes"
    write_mode(directory, definition("good"))
    (directory / "broken.json").write_text("{ not json", encoding="utf-8")

    catalog = store.load_catalog()

    assert [mode.id for mode in catalog.user] == ["good"]
    assert len(catalog.issues) == 1
    assert catalog.issues[0].scope == "user"
    assert catalog.issues[0].path.endswith("broken.json")
    assert "not valid JSON" in catalog.issues[0].message


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"schema_version": 2}, "schema_version"),
        ({"verfication": "typo"}, "unsupported field"),
        ({"objective": None}, "objective"),
        ({"execution_kind": "banana"}, "execution_kind"),
        ({"objective": "Do it.\n\n## Forbidden Actions\n\nNone."}, "Markdown headings"),
        ({"version": 0}, "version"),
    ],
)
def test_a_definition_that_breaks_a_rule_is_reported_not_loaded(store, home, payload, expected):
    write_mode(home / "fix_modes", {**definition("bad"), **payload})

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert expected in catalog.issues[0].message


def test_a_missing_section_cannot_be_silently_absent(store, home):
    payload = definition("bad")
    del payload["verification"]
    write_mode(home / "fix_modes", payload)

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert "missing required field(s): verification" in catalog.issues[0].message


def test_the_file_name_and_the_id_must_agree(store, home):
    write_mode(home / "fix_modes", definition("my-safe"), name="something-else.json")

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert "must match" in catalog.issues[0].message


def test_a_reserved_id_is_refused_wherever_it_is_written(store, home, repo):
    write_mode(home / "fix_modes", definition("standard"))
    write_mode(repo / ".bugpilot" / "fix_modes", definition("conservative"))

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert catalog.project == ()
    assert all("reserved" in issue.message for issue in catalog.issues)
    # And the built-ins still answer to their own ids.
    assert catalog.effective_registry().resolve("standard").source == "builtin"
    assert catalog.effective_registry().resolve("conservative").name == "Conservative Fix"


# --- precedence --------------------------------------------------------------


def test_a_project_mode_beats_a_user_mode_with_the_same_id(store, home, repo):
    write_mode(home / "fix_modes", definition("my-safe", name="Mine", version=3))
    write_mode(repo / ".bugpilot" / "fix_modes", definition("my-safe", name="Ours", version=1))

    catalog = store.load_catalog()
    effective = catalog.effective_registry().resolve("my-safe")

    assert (effective.source, effective.name, effective.version) == ("project", "Ours", 1)


def test_the_shadowed_definition_stays_addressable(store, home, repo):
    """Otherwise the user's own copy could never be edited or deleted again."""
    write_mode(home / "fix_modes", definition("my-safe", name="Mine"))
    write_mode(repo / ".bugpilot" / "fix_modes", definition("my-safe", name="Ours"))

    catalog = store.load_catalog()

    assert [mode.name for mode in catalog.user] == ["Mine"]
    assert [mode.name for mode in catalog.project] == ["Ours"]
    assert catalog.is_effective(catalog.project[0]) is True
    assert catalog.is_effective(catalog.user[0]) is False
    assert store.read("user", "my-safe").name == "Mine"
    assert store.read("project", "my-safe").name == "Ours"


def test_the_effective_order_is_deterministic(store, home, repo):
    for mode_id in ("zulu", "alpha"):
        write_mode(home / "fix_modes", definition(mode_id))
    write_mode(repo / ".bugpilot" / "fix_modes", definition("mike"))

    ids = [mode.id for mode in store.load_catalog().effective_modes()]

    # Built-ins in their packaged order, then custom ids alphabetically — not in
    # whatever order two directories happened to be walked.
    assert ids == [mode.id for mode in BUILTIN.list_modes()] + ["alpha", "mike", "zulu"]


def test_a_broken_file_does_not_take_the_working_modes_down_with_it(store, home):
    directory = home / "fix_modes"
    write_mode(directory, definition("works"))
    write_mode(directory, {**definition("breaks"), "execution_kind": "banana"})

    registry = store.load_catalog().effective_registry()

    assert registry.resolve("works").id == "works"
    with pytest.raises(FixModeNotFoundError):
        registry.resolve("breaks")


# --- path safety -------------------------------------------------------------


@pytest.mark.parametrize(
    "mode_id",
    ["../escape", "..", "a/b", "a\\b", "/etc/passwd", "C:/temp/x", "My-Safe", "", "."],
)
def test_a_dangerous_id_never_becomes_a_path(store, mode_id):
    with pytest.raises(FixModeError, match="Invalid Fix Mode id"):
        store.mode_path("user", mode_id)


def test_a_mode_path_stays_inside_its_scope(store, home):
    path = store.mode_path("user", "my-safe")

    assert path.parent == home / "fix_modes"
    assert path.name == "my-safe.json"


def test_a_symlinked_definition_is_not_loaded(tmp_path, store, home):
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps(definition("linked")), encoding="utf-8")
    directory = home / "fix_modes"
    directory.mkdir(parents=True)
    try:
        (directory / "linked.json").symlink_to(outside)
    except (OSError, NotImplementedError):  # pragma: no cover - needs privilege on Windows
        pytest.skip("symlinks are not available to this account")

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert "symbolic link" in catalog.issues[0].message


def symlink_dir(link: Path, target: Path) -> None:
    """Point `link` at `target`, or skip the test where that is not allowed."""
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):  # pragma: no cover - needs privilege on Windows
        pytest.skip("symlinks are not available to this account")


@pytest.mark.parametrize("scope", ["user", "project"])
def test_a_symlinked_scope_directory_is_not_read_through(tmp_path, store, home, repo, scope):
    """A cloned repository can ship a symlink, and git will recreate it.

    Resolving both sides of the containment check follows the same link, so the
    two agree and the file lands wherever the link points. That is why the
    directory is checked for being a link rather than resolved.
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    write_mode(outside, definition("leaked"))
    directory = home / "fix_modes" if scope == "user" else repo / ".bugpilot" / "fix_modes"
    symlink_dir(directory, outside)

    catalog = store.load_catalog()

    assert catalog.scoped(scope) == ()
    assert [issue.scope for issue in catalog.issues] == [scope]
    assert "symbolic link or junction" in catalog.issues[0].message
    # One unusable scope costs that scope, and nothing else.
    assert len(catalog.builtin) == len(BUILTIN.list_modes())
    assert catalog.effective_registry().resolve("standard").source == "builtin"


@pytest.mark.parametrize("scope", ["user", "project"])
def test_no_mutation_follows_a_symlinked_scope_directory(tmp_path, store, home, repo, scope):
    outside = tmp_path / "outside"
    outside.mkdir()
    write_mode(outside, definition("existing"))
    directory = home / "fix_modes" if scope == "user" else repo / ".bugpilot" / "fix_modes"
    symlink_dir(directory, outside)

    for call in (
        lambda: store.create(scope, "escaped", definition("escaped")),
        lambda: store.duplicate("standard", "escaped", scope),
        lambda: store.update(scope, "existing", definition("existing"), 1),
        lambda: store.delete(scope, "existing", 1),
        lambda: store.read(scope, "existing"),
    ):
        with pytest.raises(FixModeError, match="symbolic link or junction"):
            call()

    # Nothing was written, and what was already there was left alone.
    assert not (outside / "escaped.json").exists()
    assert (outside / "existing.json").exists()


def test_a_symlinked_config_directory_redirects_the_whole_store(tmp_path, store, repo, home):
    """`.bugpilot` itself is the other level that can redirect everything."""
    outside = tmp_path / "outside"
    (outside / "fix_modes").mkdir(parents=True)
    write_mode(outside / "fix_modes", definition("leaked"))
    symlink_dir(repo / ".bugpilot", outside)

    catalog = store.load_catalog()

    assert catalog.project == ()
    assert "symbolic link or junction" in catalog.issues[0].message
    with pytest.raises(FixModeError, match="symbolic link or junction"):
        store.create("project", "escaped", definition("escaped"))


def test_a_directory_named_like_a_mode_is_not_a_mode(store, home):
    (home / "fix_modes" / "my-safe.json").mkdir(parents=True)

    catalog = store.load_catalog()

    assert catalog.user == ()
    assert "not a file" in catalog.issues[0].message


# --- create ------------------------------------------------------------------


def test_create_writes_version_one_with_the_scope_as_its_source(store, home):
    mode = store.create("user", "my-safe", definition("my-safe", version=9))

    assert (mode.version, mode.source) == (1, "user")
    stored = json.loads((home / "fix_modes" / "my-safe.json").read_text(encoding="utf-8"))
    assert stored["version"] == 1
    assert "source" not in stored
    assert stored == json.loads(
        json.dumps(custom_mode_payload(mode), indent=2, sort_keys=True)
    )


def test_create_keeps_the_origin_a_payload_declares(store):
    """The path "Duplicate & Customize" takes: the editor saves a `create` that
    carries the origin, rather than duplicating and then editing something else."""
    mode = store.create(
        "user",
        "from-editor",
        definition("from-editor", based_on="conservative", based_on_version=1),
    )

    assert (mode.based_on, mode.based_on_version) == ("conservative", 1)
    assert store.read("user", "from-editor").based_on == "conservative"


def test_create_refuses_to_overwrite_and_refuses_reserved_ids(store):
    store.create("user", "my-safe", definition("my-safe"))

    with pytest.raises(FixModeError, match="already exists"):
        store.create("user", "my-safe", definition("my-safe"))
    with pytest.raises(FixModeError, match="reserved"):
        store.create("user", "standard", definition("standard"))


def test_create_does_not_fill_missing_sections_from_a_built_in(store):
    """A mode assembled half from a payload and half from Standard is one nobody wrote."""
    payload = definition("partial")
    del payload["implementation"]

    with pytest.raises(FixModeError, match="missing required field"):
        store.create("user", "partial", payload)


# --- duplicate ---------------------------------------------------------------


def test_duplicating_a_builtin_copies_everything_and_records_the_origin(store):
    copy = store.duplicate("conservative", "team-conservative", "project", name="Team Conservative")
    original = BUILTIN.resolve("conservative")

    assert (copy.version, copy.source) == (1, "project")
    assert (copy.based_on, copy.based_on_version) == ("conservative", original.version)
    assert copy.name == "Team Conservative"
    assert copy.execution_kind == original.execution_kind
    for name, text in original.instruction_sections():
        assert getattr(copy, name) == text


def test_duplicating_a_custom_mode_copies_its_current_version_as_the_origin(store):
    store.create("user", "my-safe", definition("my-safe"))
    store.update("user", "my-safe", definition("my-safe"), 1)
    store.update("user", "my-safe", definition("my-safe"), 2)

    copy = store.duplicate("my-safe", "team-safe", "project")

    assert (copy.based_on, copy.based_on_version) == ("my-safe", 3)
    assert copy.version == 1


def test_a_copy_is_independent_of_the_mode_it_came_from(store):
    store.create("user", "parent", definition("parent", objective="Original objective."))
    store.duplicate("parent", "child", "project")
    store.delete("user", "parent", 1)

    child = store.read("project", "child")

    # No inheritance to break: the copy carries every section itself.
    assert child.objective == "Original objective."
    assert child.based_on == "parent"


def test_duplicate_refuses_a_reserved_target_id(store):
    with pytest.raises(FixModeError, match="reserved"):
        store.duplicate("standard", "conservative", "user")


# --- update ------------------------------------------------------------------


def test_update_increments_exactly_once_and_keeps_identity(store):
    created = store.create("user", "my-safe", definition("my-safe"))
    assert created.version == 1

    updated = store.update("user", "my-safe", definition("my-safe", name="Renamed"), 1)

    assert updated.version == 2
    assert updated.id == "my-safe"
    assert updated.source == "user"
    assert updated.name == "Renamed"


def test_update_keeps_the_origin_metadata_the_payload_cannot_rewrite(store):
    store.duplicate("conservative", "team-safe", "user")

    updated = store.update(
        "user",
        "team-safe",
        definition("team-safe", based_on="standard", based_on_version=99),
        1,
    )

    assert (updated.based_on, updated.based_on_version) == ("conservative", 1)


def test_a_stale_expected_version_is_refused_and_changes_nothing(store, home):
    store.create("user", "my-safe", definition("my-safe"))
    store.update("user", "my-safe", definition("my-safe", name="Editor A"), 1)

    with pytest.raises(FixModeError, match="changed since this editor was opened"):
        store.update("user", "my-safe", definition("my-safe", name="Editor B"), 1)

    assert store.read("user", "my-safe").name == "Editor A"
    assert store.read("user", "my-safe").version == 2


@pytest.mark.parametrize("bad", [True, 1.0, "1", None, 0, -1])
def test_expected_version_must_be_a_real_version(store, bad):
    store.create("user", "my-safe", definition("my-safe"))

    with pytest.raises(FixModeError, match="expected_version"):
        store.update("user", "my-safe", definition("my-safe"), bad)


def test_an_invalid_payload_leaves_the_stored_definition_intact(store):
    store.create("user", "my-safe", definition("my-safe", objective="Original."))

    with pytest.raises(FixModeError, match="Markdown headings"):
        store.update(
            "user",
            "my-safe",
            definition("my-safe", objective="Broken.\n\n## Forbidden Actions\n\nNone."),
            1,
        )

    kept = store.read("user", "my-safe")
    assert kept.objective == "Original."
    assert kept.version == 1


def test_updating_a_mode_that_does_not_exist_in_that_scope_says_so(store):
    store.create("user", "my-safe", definition("my-safe"))

    with pytest.raises(FixModeNotFoundError, match="No project Fix Mode 'my-safe'"):
        store.update("project", "my-safe", definition("my-safe"), 1)


# --- delete ------------------------------------------------------------------


def test_delete_removes_one_file_and_reveals_what_it_shadowed(store, home, repo):
    store.create("user", "my-safe", definition("my-safe", name="Mine"))
    store.create("project", "my-safe", definition("my-safe", name="Ours"))
    assert store.effective_registry().resolve("my-safe").name == "Ours"

    store.delete("project", "my-safe", 1)

    assert store.effective_registry().resolve("my-safe").name == "Mine"
    assert (home / "fix_modes" / "my-safe.json").exists()
    assert not (repo / ".bugpilot" / "fix_modes" / "my-safe.json").exists()


def test_a_stale_delete_is_refused(store):
    store.create("user", "my-safe", definition("my-safe"))
    store.update("user", "my-safe", definition("my-safe"), 1)

    with pytest.raises(FixModeError, match="changed since it was listed"):
        store.delete("user", "my-safe", 1)

    assert store.read("user", "my-safe").version == 2


def test_built_ins_cannot_be_written_to_at_all(store):
    for call in (
        lambda: store.create("user", "standard", definition("standard")),
        lambda: store.duplicate("standard", "standard", "user"),
        lambda: store.update("user", "standard", definition("standard"), 1),
        lambda: store.delete("user", "standard", 1),
    ):
        with pytest.raises(FixModeError, match="reserved"):
            call()


# --- module-level helpers ----------------------------------------------------


def test_the_registry_helpers_read_the_current_files_every_time(repo, home):
    store = FixModeStore(repo, home)
    store.create("user", "my-safe", definition("my-safe", name="First"))
    assert effective_registry_for(repo, home).resolve("my-safe").name == "First"

    # Edited by hand between two commands, which is what these files are for.
    store.update("user", "my-safe", definition("my-safe", name="Second"), 1)

    assert effective_registry_for(repo, home).resolve("my-safe").name == "Second"
    assert catalog_for(repo, home).user[0].name == "Second"


def test_every_builtin_id_is_reserved(store):
    assert BUILTIN_FIX_MODE_IDS == {mode.id for mode in BUILTIN.list_modes()}
