"""Storage safety: links, modes, containment, traversal, Git working trees, private credentials, fresh verdicts.

0.1.6 Batch 1 (plan §8.3, §8.5, §10.2, §11.3) and Batch 2A (findings G-1, G-2,
G-3 and cache freshness). The primitives only: no product module uses
``bugpilot.core.storage`` yet, so the end-to-end cases (atomic writes on the new
tree, CLI and MCP isolation, ``clean``) come with Batch 2B. Every test runs in
Batch 0A's isolation, with a fresh ``BUGPILOT_HOME`` inside the session; links
point at a decoy folder in ``tmp_path`` that the assertions show was never
written. Git repositories are made in ``tmp_path`` only.
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

import _isolation
from bugpilot.core import private_folder, safe_paths, storage
from bugpilot.core.safe_paths import UnsafePathError, refuse_link, writable_dir
from bugpilot.core.storage import (
    GIT_WORK_TREE_ENV,
    StorageError,
    data_root,
    global_storage,
    repository_storage,
    request_scope,
)

REPO = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
POSIX = os.name == "posix"


def _forget() -> None:
    """Forget memoized identities, as a fresh process would (verdicts live only within a request scope)."""
    storage._identities.clear()


@pytest.fixture(autouse=True)
def fresh_caches(monkeypatch):
    monkeypatch.delenv(GIT_WORK_TREE_ENV, raising=False)  # a developer's own setting must not decide these tests
    _forget()
    yield
    _forget()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / "README.md").write_text("synthetic\n", encoding="utf-8")
    return root


@pytest.fixture
def decoy(tmp_path: Path) -> Path:
    """Where a planted link points: it must stay exactly as it is."""
    target = tmp_path / "decoy"
    target.mkdir()
    (target / "keep.txt").write_text("decoy\n", encoding="utf-8")
    return target


def _tree(root: Path) -> list[str]:
    if not os.path.lexists(root):
        return []
    found = []
    for current, folders, files in os.walk(root):
        for name in folders + files:
            found.append(Path(current, name).relative_to(root).as_posix())
    return sorted(found)


LINK_KINDS = ["symlink"] + (["junction"] if WINDOWS else [])


def _plant(kind: str, link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    if kind == "junction":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
        return
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symbolic links are not available here: {type(error).__name__}")


def _assert_one_clean_sentence(error: BaseException) -> None:
    message = str(error)
    assert "\n" not in message
    assert str(data_root()) not in message and str(Path.home()) not in message
    assert "BugPilot's data folder" in message or "BUGPILOT_HOME" in message or "~/.bugpilot" in message


# --- a link or junction at each of the nine components (T-S5, T-S6) ----------------------------

#: component → (where it is planted, relative to the data root, given the namespace's ID; the call that must refuse)
COMPONENTS = {
    "config": (lambda ns: ("config",), lambda ns: global_storage().ensure_config_dir()),
    "repositories": (lambda ns: ("repositories",), lambda ns: ns.ensure()),
    "<id>": (lambda ns: ("repositories", ns.identity.repository_id), lambda ns: ns.ensure()),
    "settings": (lambda ns: ns_parts(ns, "settings"), lambda ns: ns.settings_file("verification.md", create=True)),
    "work": (lambda ns: ns_parts(ns, "work"), lambda ns: ns.work_item_dir("JR-12345", create=True)),
    "<work item>": (lambda ns: ns_parts(ns, "work", "JR-12345"), lambda ns: ns.work_item_dir("JR-12345", create=True)),
    "memory": (lambda ns: ns_parts(ns, "memory"), lambda ns: ns.memory_file("JR-12345", create=True)),
    "fix_modes": (lambda ns: ns_parts(ns, "settings", "fix_modes"), lambda ns: ns.fix_modes_dir(create=True)),
    "attachments": (
        lambda ns: ns_parts(ns, "work", "JR-12345", "attachments"),
        lambda ns: ns.attachments_dir("JR-12345", create=True),
    ),
}


def ns_parts(namespace, *rest: str) -> tuple[str, ...]:
    return ("repositories", namespace.identity.repository_id, *rest)


def _prepare_up_to(namespace, parts: tuple[str, ...]) -> None:
    """Create the real folders above ``parts`` (and the record, when the link is below the namespace)."""
    if len(parts) > 2:
        namespace.ensure()
    storage._ensure_root(data_root())
    if len(parts) > 1:
        storage._directory(data_root(), parts[:-1], create=True)


@pytest.mark.parametrize("kind", LINK_KINDS)
@pytest.mark.parametrize("component", list(COMPONENTS))
def test_a_link_at_any_component_is_refused_and_nothing_is_written_through_it(repo, decoy, kind, component):
    namespace = repository_storage(repo)
    locate, call = COMPONENTS[component]
    parts = locate(namespace)
    _prepare_up_to(namespace, parts)
    _plant(kind, data_root().joinpath(*parts), decoy)
    decoy_before = _tree(decoy)
    with pytest.raises(StorageError) as refused:
        call(namespace)
    assert "symbolic link or junction" in str(refused.value)
    _assert_one_clean_sentence(refused.value)
    assert _tree(decoy) == decoy_before
    assert (decoy / "keep.txt").read_text(encoding="utf-8") == "decoy\n"


@pytest.mark.parametrize("component", list(COMPONENTS))
def test_a_link_swapped_in_right_after_mkdir_is_refused(repo, decoy, component, monkeypatch):
    """The re-check after each ``mkdir`` catches a link made in between (§8.7)."""
    namespace = repository_storage(repo)
    locate, call = COMPONENTS[component]
    parts = locate(namespace)
    _prepare_up_to(namespace, parts)
    target = data_root().joinpath(*parts)
    real_mkdir = Path.mkdir

    def mkdir_then_swap(self, *args, **kwargs):
        real_mkdir(self, *args, **kwargs)
        if os.path.normcase(str(self)) == os.path.normcase(str(target)):
            self.rmdir()
            _plant(LINK_KINDS[-1], self, decoy)

    monkeypatch.setattr(Path, "mkdir", mkdir_then_swap)
    with pytest.raises(StorageError, match="became a symbolic link or junction") as refused:
        call(namespace)
    _assert_one_clean_sentence(refused.value)
    assert _tree(decoy) == ["keep.txt"]


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_reads_refuse_a_link_at_the_settings_folder_or_file(repo, decoy, kind):
    namespace = repository_storage(repo)
    namespace.ensure()
    _plant(kind, (namespace._directory / "settings"), decoy)
    with pytest.raises(StorageError, match="symbolic link or junction"):
        namespace.settings_file("verification.md", create=False)


def test_reads_refuse_a_link_at_a_settings_file(repo, tmp_path):
    namespace = repository_storage(repo)
    folder = namespace.settings_file("verification.md", create=True).parent
    outside = tmp_path / "outside.md"
    outside.write_text("x", encoding="utf-8")
    try:
        os.symlink(outside, folder / "verification.md")
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"file symbolic links are not available here: {type(error).__name__}")
    with pytest.raises(StorageError, match="symbolic link or junction"):
        namespace.settings_file("verification.md", create=False)


def test_a_linked_work_item_is_skipped_by_the_listing(repo, decoy):
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-1", create=True)
    _plant(LINK_KINDS[-1], (namespace._directory / "work") / "JR-2", decoy)
    assert [item.work_item_id for item in namespace.work_items()] == ["JR-1"]


# --- the data root itself ----------------------------------------------------------------------


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_data_root_behind_a_link_works_and_writes_land_in_its_target(repo, tmp_path, monkeypatch, kind):
    """The user may put the data root behind a link (owner decision B4-2, T-S4)."""
    target = tmp_path / "real-data-root"
    target.mkdir()
    link = tmp_path / "linked-data-root"
    _plant(kind, link, target)
    monkeypatch.setenv("BUGPILOT_HOME", str(link))
    namespace = repository_storage(repo)
    work = namespace.work_item_dir("JR-12345", create=True)
    assert work.is_dir()
    assert (target / "repositories" / namespace.identity.repository_id / "work" / "JR-12345").is_dir()


def test_a_data_root_that_is_a_file_is_refused(repo, monkeypatch, tmp_path):
    occupied = tmp_path / "occupied"
    occupied.write_text("not a folder", encoding="utf-8")
    monkeypatch.setenv("BUGPILOT_HOME", str(occupied))
    with pytest.raises(StorageError, match="not a folder") as refused:
        repository_storage(repo).ensure()
    assert str(tmp_path) not in str(refused.value)
    assert occupied.read_text(encoding="utf-8") == "not a folder"


def test_a_missing_parent_of_the_data_root_is_refused_never_created(repo, monkeypatch, tmp_path):
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / "missing-parent" / "root"))
    with pytest.raises(StorageError, match="does not exist") as refused:
        repository_storage(repo).ensure()
    assert str(tmp_path) not in str(refused.value)
    assert not (tmp_path / "missing-parent").exists()


# The root itself, as ``_ensure_root`` sees it (Batch 2B-1 follow-up: what is at the name is judged only after the
# attempt to create it). ``data_root()`` is canonical, so a configured link reaches it resolved (B4-2); these tests
# hand it the configured name itself, to show what it does when that name is occupied.


def test_an_existing_data_root_folder_is_used_as_it_is():
    root = data_root()
    root.mkdir()
    (root / "keep.txt").write_text("kept\n", encoding="utf-8")
    storage._ensure_root(root)
    assert _tree(root) == ["keep.txt"]
    assert (root / "keep.txt").read_text(encoding="utf-8") == "kept\n"


def test_a_missing_data_root_is_created_as_a_real_folder():
    root = data_root()
    assert not os.path.lexists(root)
    storage._ensure_root(root)
    assert root.is_dir() and not safe_paths.is_link_or_junction(root)
    assert _tree(root) == []


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_dangling_link_at_the_data_root_is_refused_and_nothing_is_created_through_it(tmp_path, monkeypatch, kind):
    target = tmp_path / "gone"
    target.mkdir()
    link = tmp_path / "dangling-data-root"
    _plant(kind, link, target)
    target.rmdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(link))
    with pytest.raises(StorageError, match="not a folder") as refused:
        storage._ensure_root(link)
    assert str(tmp_path) not in str(refused.value)
    assert not os.path.lexists(target)  # nothing created through the link
    assert safe_paths.is_link_or_junction(link)  # and the link itself left as it was


@pytest.mark.skipif(WINDOWS, reason="a link to a file needs the file-symlink privilege on Windows")
def test_a_link_to_a_file_at_the_data_root_is_refused_and_the_file_kept(tmp_path, monkeypatch):
    target = tmp_path / "a-file"
    target.write_text("not a folder", encoding="utf-8")
    link = tmp_path / "file-link-data-root"
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symbolic links are not available here: {type(error).__name__}")
    monkeypatch.setenv("BUGPILOT_HOME", str(link))
    with pytest.raises(StorageError, match="not a folder"):
        storage._ensure_root(link)
    assert target.read_text(encoding="utf-8") == "not a folder"
    assert os.path.islink(link)


@pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
@pytest.mark.skipif(POSIX and os.geteuid() == 0, reason="root ignores directory permissions")
def test_a_data_root_that_cannot_be_created_raises_and_creates_nothing(tmp_path, monkeypatch):
    parent = tmp_path / "locked"
    parent.mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(parent / "root"))
    os.chmod(parent, 0o500)
    try:
        with pytest.raises(PermissionError):
            storage._ensure_root(data_root())
    finally:
        os.chmod(parent, 0o700)
    assert not os.path.lexists(parent / "root")


def test_nothing_is_created_inside_the_repository(repo):
    before = _tree(repo)
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-12345", create=True)
    namespace.attachments_dir("JR-12345", create=True)
    namespace.memory_file("JR-12345", create=True)
    namespace.settings_file("instructions.md", create=True)
    namespace.fix_modes_dir(create=True)
    global_storage().ensure_config_dir()
    assert _tree(repo) == before
    assert not os.path.commonpath([os.path.realpath(data_root()), os.path.realpath(repo)]) == os.path.realpath(repo)


def test_the_global_config_folder_is_created_private_and_link_checked(decoy):
    config = global_storage().ensure_config_dir()
    assert config == data_root() / "config" and config.is_dir()
    assert global_storage().ensure_config_dir() == config  # idempotent


# --- modes (POSIX; T-S18, US-D23) --------------------------------------------------------------


def _mode(path: Path) -> int:
    return stat.S_IMODE(os.lstat(path).st_mode)


@pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
@pytest.mark.parametrize("umask", [0o022, 0o002, 0o000, 0o077])
def test_every_new_folder_is_0700_and_the_record_0600_under_common_umasks(repo, umask):
    previous = os.umask(umask)
    try:
        namespace = repository_storage(repo)
        namespace.work_item_dir("JR-12345", create=True)
        namespace.attachments_dir("JR-12345", create=True)
        namespace.memory_file("JR-12345", create=True)
        namespace.fix_modes_dir(create=True)
        global_storage().ensure_config_dir()
    finally:
        os.umask(previous)
    for relative in _tree(data_root()):
        path = data_root() / relative
        expected = 0o600 if path.is_file() else 0o700
        assert _mode(path) == expected, (relative, oct(_mode(path)))
    assert _mode(data_root()) == 0o700


@pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
@pytest.mark.skipif(POSIX and os.geteuid() == 0, reason="root ignores directory permissions")
def test_a_restrictive_umask_narrows_never_widens_and_the_failure_is_reported(repo):
    previous = os.umask(0o277)
    try:
        with pytest.raises(OSError):
            repository_storage(repo).ensure()
    finally:
        os.umask(previous)
    assert _mode(data_root()) == 0o500  # 0700 narrowed by the umask: never wider
    for relative in _tree(data_root()):
        assert _mode(data_root() / relative) & 0o077 == 0, relative


@pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
def test_an_existing_data_roots_mode_is_never_changed(repo):
    data_root().mkdir(mode=0o755)
    os.chmod(data_root(), 0o755)
    repository_storage(repo).work_item_dir("JR-12345", create=True)
    global_storage().ensure_config_dir()
    assert _mode(data_root()) == 0o755
    assert _mode(data_root() / "repositories") == 0o700


# --- traversal and the closed sets (T-S2) ------------------------------------------------------


def _ids() -> dict[str, list[str]]:
    return json.loads((REPO / "tests" / "fixtures" / "work_item_ids.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("work_item_id", _ids()["invalid"] + ["../JR-1", "JR-1/../../x", "..\\JR-1", "JR-1\x00", "JR-1\n"])
def test_an_invalid_work_item_id_is_refused_before_any_path_is_built(repo, work_item_id):
    namespace = repository_storage(repo)
    for access in (
        lambda: namespace.work_item_dir(work_item_id, create=True),
        lambda: namespace.work_item_dir(work_item_id, create=False),
        lambda: namespace.attachments_dir(work_item_id, create=True),
        lambda: namespace.memory_file(work_item_id, create=True),
    ):
        with pytest.raises(StorageError, match="Invalid issue key or work item id"):
            access()
    assert not os.path.lexists(data_root())


@pytest.mark.parametrize("work_item_id", _ids()["valid"])
def test_a_valid_work_item_id_stays_inside_its_namespace(repo, work_item_id):
    namespace = repository_storage(repo)
    folder = namespace.work_item_dir(work_item_id, create=True)
    assert folder.parent == (namespace._directory / "work")
    assert os.path.realpath(folder).startswith(os.path.realpath(namespace._directory))


@pytest.mark.parametrize("name", ["config.toml", "../instructions.md", "fix_modes", "repository.json", "", "settings"])
def test_only_the_closed_set_of_settings_files_can_be_addressed(repo, name):
    with pytest.raises(StorageError, match="not one of BugPilot's repository settings files"):
        repository_storage(repo).settings_file(name, create=True)  # type: ignore[arg-type]
    assert not os.path.lexists(data_root())


# --- the safe_paths generalization keeps today's messages (§8.5) ------------------------------


def test_the_repository_messages_are_byte_identical_to_0_1_5(tmp_path, decoy):
    """Existing callers pass no boundary: their refusals read exactly as before."""
    base = tmp_path / "repo-base"
    base.mkdir()
    _plant(LINK_KINDS[-1], base / ".ai", decoy)
    with pytest.raises(UnsafePathError) as refused:
        writable_dir(base, (".ai", "JR-1"))
    assert str(refused.value) == (
        "BugPilot cannot write .ai/JR-1: .ai is a symbolic link or junction. BugPilot writes generated files only "
        "into real directories inside this repository, and never through a link. Nothing was written."
    )
    with pytest.raises(UnsafePathError) as refused:
        refuse_link(base / ".ai")
    assert str(refused.value) == (
        "BugPilot cannot write .ai: .ai is a symbolic link or junction. BugPilot writes generated files only "
        "into real directories inside this repository, and never through a link. Nothing was written."
    )
    (base / "plain").write_text("x", encoding="utf-8")
    with pytest.raises(UnsafePathError) as refused:
        writable_dir(base, ("plain", "x"))
    assert str(refused.value) == (
        "BugPilot cannot write plain/x: plain is not a directory. BugPilot writes generated files only into real "
        "directories inside this repository, and never through a link. Nothing was written."
    )


def test_the_data_folder_boundary_and_mode_are_used_only_when_asked(tmp_path, decoy):
    base = tmp_path / "data-base"
    base.mkdir()
    _plant(LINK_KINDS[-1], base / "repositories", decoy)
    with pytest.raises(UnsafePathError) as refused:
        writable_dir(base, ("repositories", "x"), boundary=storage.DATA_ROOT_BOUNDARY)
    assert "inside BugPilot's data folder" in str(refused.value)
    assert "this repository" not in str(refused.value)
    made = writable_dir(base, ("made",), mode=0o700)
    assert made.is_dir()
    if POSIX:
        assert _mode(made) & 0o077 == 0
    assert safe_paths.REPOSITORY_BOUNDARY == "this repository"


# --- no legacy reads (R4) ----------------------------------------------------------------------


def test_the_storage_api_never_reads_a_legacy_location(repo):
    """The 0.1.5 locations are protected by the test guard: a read or a listing of one would fail the test."""
    legacy_in_repo = [repo / ".ai", repo / ".ai_memory", repo / ".bugpilot"]
    for folder in legacy_in_repo:
        (folder / "x").mkdir(parents=True)
        (folder / "x" / "canary.md").write_text("canary\n", encoding="utf-8")
    storage._ensure_root(data_root())
    legacy_top = [data_root() / "config.toml", data_root() / "instructions.md", data_root() / "fix_modes"]
    legacy_top[0].write_text('jira_token = "canary"\n', encoding="utf-8")
    legacy_top[1].write_text("canary\n", encoding="utf-8")
    legacy_top[2].mkdir()
    with _isolation.expecting_violations() as refused:
        with _ProtectingAll([*legacy_in_repo, *legacy_top]):
            namespace = repository_storage(repo)
            namespace.work_item_dir("JR-12345", create=True)
            namespace.memory_file("JR-12345", create=True)
            namespace.settings_file("instructions.md", create=True)
            namespace.fix_modes_dir(create=True)
            namespace.work_items()
            namespace.record_state()
            global_storage().ensure_config_dir()
    assert refused == []
    assert (legacy_top[0]).read_text(encoding="utf-8") == 'jira_token = "canary"\n'


class _ProtectingAll:
    def __init__(self, paths: list[Path]) -> None:
        self._contexts = [_isolation.protecting(str(path)) for path in paths]

    def __enter__(self):
        for context in self._contexts:
            context.__enter__()
        return self

    def __exit__(self, *exc):
        for context in reversed(self._contexts):
            context.__exit__(*exc)
        return False


# --- H1: the data root and the repository are kept apart (R5) ----------------------------------


def _every_access(namespace) -> dict[str, object]:
    return {
        "ensure": namespace.ensure,
        "record_state": namespace.record_state,
        "work_item_dir(write)": lambda: namespace.work_item_dir("JR-12345", create=True),
        "work_item_dir(read)": lambda: namespace.work_item_dir("JR-12345", create=False),
        "memory_file(read)": lambda: namespace.memory_file("JR-12345", create=False),
        "settings_file(write)": lambda: namespace.settings_file("verification.md", create=True),
        "fix_modes_dir(read)": lambda: namespace.fix_modes_dir(create=False),
        "work_items": namespace.work_items,
    }


def _assert_refused_entirely(namespace, repo: Path, match: str) -> None:
    repo_before = _tree(repo)
    root_existed = os.path.lexists(data_root())
    for label, access in _every_access(namespace).items():
        with pytest.raises(StorageError, match=match) as refused:
            access()
        message = str(refused.value)
        assert str(repo) not in message and str(Path.home()) not in message, label
        assert "Nothing was read or written" in message, label
    assert _tree(repo) == repo_before  # nothing created in the repository
    assert os.path.lexists(data_root()) == root_existed  # nor the data root


def test_a_data_root_inside_the_repository_is_refused_for_reads_and_writes(repo, monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", str(repo / ".bugpilot-data"))
    _assert_refused_entirely(repository_storage(repo), repo, "will not keep its data inside this repository")


def test_a_data_root_equal_to_the_repository_is_refused(repo, monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", str(repo))
    _assert_refused_entirely(repository_storage(repo), repo, "will not keep its data inside this repository")


def test_a_repository_that_is_the_home_folder_is_refused_by_default(tmp_path, monkeypatch):
    """A dotfiles repository at ``~``, or the home folder opened as a workspace: ``~/.bugpilot`` is inside it."""
    home = tmp_path / "home-as-repository"
    home.mkdir()
    for name, value in _isolation._home_environment(str(home)).items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)
    assert data_root() == Path(os.path.realpath(home / ".bugpilot"))
    _assert_refused_entirely(repository_storage(home), home, "will not keep its data inside this repository")


def test_a_repository_above_the_default_data_root_is_refused(tmp_path, monkeypatch):
    above = tmp_path / "above"
    home = above / "home"
    home.mkdir(parents=True)
    for name, value in _isolation._home_environment(str(home)).items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)
    _assert_refused_entirely(repository_storage(above), above, "will not keep its data inside this repository")


def test_a_repository_inside_the_data_root_is_refused(tmp_path, monkeypatch):
    root = tmp_path / "data-root"
    inner = root / "repositories" / "checkout"
    inner.mkdir(parents=True)
    monkeypatch.setenv("BUGPILOT_HOME", str(root))
    namespace = repository_storage(inner)
    before = _tree(root)
    for access in _every_access(namespace).values():
        with pytest.raises(StorageError, match="will not use a repository inside its own data folder"):
            access()
    assert _tree(root) == before


@pytest.mark.skipif(not WINDOWS, reason="Windows: letter case is folded")
def test_a_case_variant_of_the_repository_in_bugpilot_home_is_still_inside(repo, monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", str(repo).upper() + os.sep + "DATA")
    _assert_refused_entirely(repository_storage(repo), repo, "will not keep its data inside this repository")


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_cannot_smuggle_the_data_root_into_the_repository(repo, tmp_path, monkeypatch, kind):
    """``BUGPILOT_HOME`` is a link outside the repository whose target is inside it."""
    inside = repo / "hidden-data"
    inside.mkdir()
    link = tmp_path / "innocent-looking-root"
    _plant(kind, link, inside)
    monkeypatch.setenv("BUGPILOT_HOME", str(link))
    _assert_refused_entirely(repository_storage(repo), repo, "will not keep its data inside this repository")


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_file_identity_catches_an_alias_the_canonical_path_would_miss(repo, tmp_path, monkeypatch, kind):
    """The second comparison (file identity along the ancestors) on its own: ``realpath`` disabled."""
    alias = tmp_path / "alias-of-the-repository"
    _plant(kind, alias, repo)
    monkeypatch.setenv("BUGPILOT_HOME", str(alias / ".bugpilot-data"))
    monkeypatch.setattr(storage.os.path, "realpath", lambda path, *args, **kwargs: os.path.abspath(path))
    namespace = repository_storage(repo)
    assert storage._containment_problem(namespace._data_root, namespace.identity) == "inside"


@pytest.mark.parametrize("name", ["beside", "checkout-data", "checkout.bugpilot"])
def test_a_data_root_beside_the_repository_is_accepted(repo, tmp_path, monkeypatch, name):
    """Components are compared, never text: ``checkout-data`` is not inside ``checkout``."""
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / name))
    assert repository_storage(repo).work_item_dir("JR-12345", create=True).is_dir()


@pytest.mark.parametrize("parts", [("repositories", ".."), ("repositories", "a/b"), ("work", ""), ("work", ".")])
def test_read_paths_refuse_a_component_that_is_not_a_plain_name(parts):
    """Review finding L9: reads check every component as writes do, before looking at the disk."""
    with pytest.raises(StorageError, match="invalid generated path"):
        storage._existing(data_root(), parts)
    assert not os.path.lexists(data_root())


# --- M1: an identity record is never overwritten ------------------------------------------------


@pytest.fixture
def no_replace(monkeypatch):
    """``os.replace`` must never be part of publishing a record: calling it fails the test."""

    def refuse(*args, **kwargs):
        raise AssertionError("os.replace called while publishing a record")

    monkeypatch.setattr(storage.os, "replace", refuse)


def _no_hard_links(monkeypatch) -> None:
    def link(*args, **kwargs):
        raise OSError(errno.EPERM, "no hard links on this file system")

    monkeypatch.setattr(storage.os, "link", link)


def _leftover_temps(namespace) -> list[str]:
    return [name for name in os.listdir(namespace._directory) if name.endswith(".tmp")]


def test_publication_by_hard_link_leaves_one_record_and_no_temp(repo, no_replace):
    namespace = repository_storage(repo)
    namespace.ensure()
    assert namespace.record_state() == "ok"
    assert _leftover_temps(namespace) == []


@pytest.mark.skipif(not WINDOWS, reason="Windows: os.rename raises instead of replacing (POSIX's would replace)")
def test_without_hard_links_windows_publishes_by_a_rename_that_never_replaces(repo, monkeypatch, no_replace):
    _no_hard_links(monkeypatch)
    namespace = repository_storage(repo)
    namespace.ensure()
    assert namespace.record_state() == "ok"
    assert _leftover_temps(namespace) == []


@pytest.mark.skipif(not WINDOWS, reason="Windows: os.rename raises instead of replacing (POSIX's would replace)")
def test_without_hard_links_a_record_published_meanwhile_is_kept(repo, monkeypatch, no_replace):
    """The race of the review's probe: another record appears just before this publish's rename."""
    _no_hard_links(monkeypatch)
    namespace = repository_storage(repo)
    storage._ensure_root(data_root())
    storage._directory(data_root(), ("repositories", namespace.identity.repository_id), create=True)
    conflicting = json.dumps({"schema_version": 1, "repository_id": namespace.identity.repository_id, "root": "elsewhere"})
    real_rename = os.rename

    def rename_after_another_publish(source, target):
        Path(target).write_text(conflicting, encoding="utf-8")
        return real_rename(source, target)

    monkeypatch.setattr(storage.os, "rename", rename_after_another_publish)
    with pytest.raises(storage.StorageIdentityError, match="belongs to a different repository folder"):
        namespace.ensure()
    assert namespace._record_file.read_text(encoding="utf-8") == conflicting
    assert _leftover_temps(namespace) == []


def test_without_hard_links_posix_refuses_rather_than_risk_a_replacement(repo, monkeypatch, no_replace):
    """POSIX has no rename that refuses to replace: BugPilot refuses instead, and writes nothing."""
    _no_hard_links(monkeypatch)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace = repository_storage(repo)
    with pytest.raises(StorageError, match="has no hard links") as refused:
        namespace.ensure()
    assert str(data_root()) not in str(refused.value)
    assert not namespace._record_file.exists()
    assert _leftover_temps(namespace) == []


def test_without_hard_links_an_existing_record_is_untouched(repo, monkeypatch, no_replace):
    namespace = repository_storage(repo)
    namespace.ensure()
    before = namespace._record_file.read_bytes()
    _no_hard_links(monkeypatch)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace.ensure()  # an existing valid record: nothing to publish
    namespace.ensure()  # verified again from disk: still nothing written
    assert namespace._record_file.read_bytes() == before


def test_another_link_failure_is_not_disguised_as_missing_hard_links(repo, monkeypatch, no_replace):
    def link(*args, **kwargs):
        raise OSError(errno.EACCES, "permission denied")

    monkeypatch.setattr(storage.os, "link", link)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace = repository_storage(repo)
    with pytest.raises(OSError) as failed:
        namespace.ensure()
    assert not isinstance(failed.value, StorageError) and failed.value.errno == errno.EACCES
    assert not namespace._record_file.exists()


def test_a_refused_temp_file_name_publishes_nothing(repo, monkeypatch, no_replace):
    def refuse(handle, temp, path):
        raise safe_paths.UnsafePathError("BugPilot cannot write repository.json: its temporary file's name was a link.")

    monkeypatch.setattr(storage, "_check_temp", refuse)
    namespace = repository_storage(repo)
    with pytest.raises(StorageError, match="temporary file"):
        namespace.ensure()
    assert not namespace._record_file.exists()
    assert _leftover_temps(namespace) == []


# --- M3: concurrent readers and clean-up ---------------------------------------------------------


def test_a_temp_name_that_cannot_be_removed_does_not_fail_a_published_record(repo, monkeypatch):
    """The publish succeeded; the stray temp name is left (documented), and no error misreports it."""

    def locked(path, *args, **kwargs):
        raise PermissionError(13, "in use")

    monkeypatch.setattr(storage.os, "unlink", locked)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    namespace = repository_storage(repo)
    namespace.ensure()
    assert namespace.record_state() == "ok"
    assert len(_leftover_temps(namespace)) == 1


def test_a_temp_name_held_for_a_moment_is_removed_on_retry(repo, monkeypatch):
    real_unlink = os.unlink
    attempts = {"count": 0}

    def busy_twice(path, *args, **kwargs):
        attempts["count"] += 1
        if attempts["count"] <= 2:
            raise PermissionError(13, "in use")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "unlink", busy_twice)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    namespace = repository_storage(repo)
    namespace.ensure()
    assert _leftover_temps(namespace) == [] and attempts["count"] == 3


def test_a_transient_sharing_violation_on_read_is_retried_not_called_corrupt(repo, monkeypatch):
    namespace = repository_storage(repo)
    namespace.ensure()
    real_open = os.open
    attempts = {"count": 0}

    def busy_twice(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(namespace._record_file):
            attempts["count"] += 1
            if attempts["count"] <= 2:
                raise PermissionError(13, "sharing violation")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "open", busy_twice)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    assert namespace.record_state() == "ok"


def test_a_record_that_stays_unreadable_is_reported_as_such_never_as_corrupt(repo, monkeypatch):
    namespace = repository_storage(repo)
    namespace.ensure()
    before = namespace._record_file.read_bytes()
    real_open = os.open

    def always_locked(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(namespace._record_file):
            raise PermissionError(13, "sharing violation")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "open", always_locked)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    for access in (namespace.ensure, namespace.record_state, lambda: namespace.work_item_dir("JR-1", create=False)):
        with pytest.raises(StorageError, match="cannot read .* right now") as refused:
            access()
        assert not isinstance(refused.value, storage.StorageIdentityError)
        assert "delete" not in str(refused.value) and str(data_root()) not in str(refused.value)
    assert namespace._record_file.read_bytes() == before


def test_a_failed_clean_up_never_masks_the_error_on_its_way_out(repo, monkeypatch):
    def refuse(handle, temp, path):
        raise safe_paths.UnsafePathError("BugPilot cannot write repository.json: its temporary file's name was a link.")

    def locked(path, *args, **kwargs):
        raise PermissionError(13, "in use")

    monkeypatch.setattr(storage, "_check_temp", refuse)
    monkeypatch.setattr(storage.os, "unlink", locked)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    with pytest.raises(StorageError, match="temporary file"):  # the publish's own error, not the clean-up's
        repository_storage(repo).ensure()


def test_read_paths_refuse_a_component_that_is_a_file(repo):
    namespace = repository_storage(repo)
    namespace.ensure()
    (namespace._directory / "work").write_text("not a folder", encoding="utf-8")
    with pytest.raises(StorageError, match="work is not a directory"):
        namespace.work_item_dir("JR-1", create=False)


# --- H2: Windows access control -----------------------------------------------------------------


def _windows_python_applies_mode_0700() -> bool:
    """CPython applies ``mode=0o700`` as an owner-only access list from 3.10.15, 3.11.10, 3.12.4 and 3.13."""
    version = sys.version_info[:3]
    return version >= (3, 13) or (3, 12, 4) <= version < (3, 13) or (3, 11, 10) <= version < (3, 12) or (3, 10, 15) <= version < (3, 11)


def _dacl(path: Path) -> tuple[bool, set[tuple[int, str]]]:
    """The folder's access list, read only: (protected from inheritance, {(ACE type, SID)})."""
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    descriptor, dacl = ctypes.c_void_p(), ctypes.c_void_p()
    status = advapi32.GetNamedSecurityInfoW(
        ctypes.c_wchar_p(str(path)), 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(descriptor)
    )  # SE_FILE_OBJECT, DACL_SECURITY_INFORMATION
    assert status == 0, status
    try:
        control, revision = wintypes.WORD(), wintypes.DWORD()
        assert advapi32.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision))
        protected = bool(control.value & 0x1000)  # SE_DACL_PROTECTED
        count = ctypes.cast(dacl, ctypes.POINTER(wintypes.WORD))[2]  # ACL: revision, sbz1, size, AceCount
        entries = set()
        for index in range(count):
            ace = ctypes.c_void_p()
            assert advapi32.GetAce(dacl, index, ctypes.byref(ace))
            ace_type = ctypes.cast(ace, ctypes.POINTER(ctypes.c_ubyte))[0]
            sid = ctypes.c_void_p(ace.value + 8)  # ACCESS_ALLOWED_ACE: header (4), mask (4), then the SID
            text = ctypes.c_wchar_p()
            assert advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text))
            entries.add((ace_type, text.value))
            kernel32.LocalFree(text)
        return protected, entries
    finally:
        kernel32.LocalFree(descriptor)


def _volume_keeps_access_lists(path: Path) -> bool:
    """Whether the volume holding ``path`` stores access lists (``FILE_PERSISTENT_ACLS``): NTFS and ReFS do, FAT does not."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    volume = ctypes.create_unicode_buffer(261)
    if not kernel32.GetVolumePathNameW(ctypes.c_wchar_p(str(path)), volume, len(volume)):
        return False
    flags = wintypes.DWORD()
    if not kernel32.GetVolumeInformationW(volume, None, 0, None, None, ctypes.byref(flags), None, 0):
        return False
    return bool(flags.value & 0x00000008)


OWNER_ONLY = {(0, "S-1-5-18"), (0, "S-1-5-32-544"), (0, "S-1-3-4")}  # SYSTEM, Administrators, OWNER RIGHTS


@pytest.mark.skipif(not WINDOWS, reason="Windows access lists; POSIX permission bits are tested above and prove nothing here")
@pytest.mark.skipif(
    WINDOWS and not _windows_python_applies_mode_0700(),
    reason="this Python ignores mode on Windows (before 3.10.15, 3.11.10, 3.12.4): folders inherit their parent's access list",
)
def test_windows_folders_get_an_owner_only_access_list_that_is_not_inherited(repo):
    """Review finding H2, measured: each folder BugPilot creates holds exactly SYSTEM, Administrators and its owner.

    ``config/``, which will hold credentials, is among them (gate condition G-5). Synthetic folders only.
    Not covered, by design: a Python that ignores the mode (skipped above); a volume without access lists
    (FAT, exFAT: skipped below); a network share, whose access is the server's; a folder that already
    existed, whose list BugPilot never changes (US-D23). Those are what the Q1 credential check is for.
    """
    if not _volume_keeps_access_lists(data_root().parent):
        pytest.skip("the temporary folder's volume keeps no access lists (FAT or exFAT)")
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-12345", create=True)
    global_storage().ensure_config_dir()
    created = [
        data_root(),
        data_root() / "repositories",
        namespace._directory,
        (namespace._directory / "work"),
        (namespace._directory / "work") / "JR-12345",
        global_storage()._config_dir,
    ]
    for folder in created:
        protected, entries = _dacl(folder)
        assert protected, folder.name
        assert entries == OWNER_ONLY, (folder.name, entries)
    # The record inherits the same three entries from its folder.
    assert _dacl(namespace._record_file)[1] == OWNER_ONLY


# --- G-1 and G-2: never inside a Git working tree (Batch 2A) ------------------------------------

GIT = shutil.which("git")
needs_git = pytest.mark.skipif(GIT is None, reason="needs git for a real worktree or --separate-git-dir")


def _git(*args: str, cwd: Path) -> None:
    subprocess.run(
        [GIT, "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false",
         "-c", "init.defaultBranch=main", *args],
        cwd=cwd, check=True, capture_output=True,
    )


def _checkout(path: Path, *, commit: bool = False) -> Path:
    """A real Git checkout in ``tmp_path``."""
    path.mkdir(parents=True, exist_ok=True)
    _git("init", "-q", cwd=path)
    if commit:
        (path / "README.md").write_text("synthetic\n", encoding="utf-8")
        _git("add", "-A", cwd=path)
        _git("commit", "-qm", "initial", cwd=path)
    return path


def _marked(path: Path, kind: str = "folder") -> Path:
    """A folder carrying a ``.git`` marker, without git: an empty folder, or the file of a linked worktree."""
    path.mkdir(parents=True, exist_ok=True)
    if kind == "folder":
        (path / ".git").mkdir()
    else:
        (path / ".git").write_text("gitdir: ../elsewhere.git\n", encoding="utf-8")
    return path


def _global_accesses() -> dict[str, object]:
    g = global_storage()
    return {
        "ensure_config_dir": g.ensure_config_dir,
        "config_file(write)": lambda: g.config_file(create=True),
        "config_file(read)": lambda: g.config_file(create=False),
        "write_config_file": lambda: g.write_config_file("jira_token = 'never-shown'\n"),
        "user_instructions_file(write)": lambda: g.user_instructions_file(create=True),
        "user_instructions_file(read)": lambda: g.user_instructions_file(create=False),
        "user_fix_modes_dir(write)": lambda: g.user_fix_modes_dir(create=True),
        "user_fix_modes_dir(read)": lambda: g.user_fix_modes_dir(create=False),
    }


def _assert_refused(accesses: dict[str, object], watched: Path, match: str = "inside a Git working tree") -> None:
    """Every access refused with one sentence and no path; nothing created under ``watched``."""
    before = _tree(watched)
    root_existed = os.path.lexists(data_root())
    for label, access in accesses.items():
        with pytest.raises(StorageError, match=match) as refused:
            access()
        message = str(refused.value)
        assert str(watched) not in message and str(Path.home()) not in message, label
        assert "Nothing was read or written" in message, label
        assert "never-shown" not in message, label
    assert _tree(watched) == before
    assert os.path.lexists(data_root()) == root_existed


def test_the_test_folders_are_outside_every_git_working_tree():
    """These tests mean nothing if the test session itself sits in a Git working tree: say so plainly."""
    assert storage._git_tree_problem(data_root()) is None, (
        "the test session's temporary folder is inside a Git working tree (a .git above it, or GIT_WORK_TREE); "
        "run the tests with a temporary folder outside every checkout"
    )


@pytest.mark.parametrize("kind", ["marker", pytest.param("git", marks=needs_git)])
def test_a_run_from_a_subfolder_with_the_data_root_elsewhere_in_the_checkout_is_refused(tmp_path, monkeypatch, kind):
    """G-1, case A of the gate review: the folder BugPilot runs in is a subfolder; the data root is in the checkout."""
    checkout = _checkout(tmp_path / "checkout") if kind == "git" else _marked(tmp_path / "checkout")
    subfolder = checkout / "src"
    subfolder.mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / ".bugpilot-data"))
    namespace = repository_storage(subfolder)
    _assert_refused({**_every_access(namespace), **_global_accesses()}, checkout)
    # US-D4 unchanged: the repository is still the folder BugPilot runs in, not the checkout's top.
    assert namespace.identity.root == Path(os.path.realpath(subfolder))


def test_global_configuration_is_never_created_inside_a_checkout(tmp_path, monkeypatch):
    """G-2, case B: no repository is involved, and the data root's place alone decides."""
    checkout = _marked(tmp_path / "checkout")
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "data"))
    _assert_refused(_global_accesses(), checkout)


def test_a_home_folder_that_is_a_git_repository_keeps_the_default_data_root_out(tmp_path, monkeypatch):
    """G-1, case C: dotfiles kept with a .git in the home folder; BugPilot runs in a project below it."""
    home = _marked(tmp_path / "home")
    project = home / "src" / "project"
    project.mkdir(parents=True)
    for name, value in _isolation._home_environment(str(home)).items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)
    _assert_refused({**_every_access(repository_storage(project)), **_global_accesses()}, home)
    assert not os.path.lexists(home / storage.DEFAULT_DATA_DIR_NAME)


@needs_git
def test_a_linked_worktree_is_a_working_tree(tmp_path, monkeypatch):
    main = _checkout(tmp_path / "main", commit=True)
    worktree = tmp_path / "linked"
    _git("worktree", "add", "-q", str(worktree), cwd=main)
    assert (worktree / ".git").is_file()
    monkeypatch.setenv("BUGPILOT_HOME", str(worktree / "data"))
    _assert_refused(_global_accesses(), worktree)


@needs_git
def test_a_repository_with_a_separate_git_dir_is_a_working_tree(tmp_path, monkeypatch):
    checkout = tmp_path / "separate"
    _git("init", "-q", "--separate-git-dir", str(tmp_path / "elsewhere.git"), str(checkout), cwd=tmp_path)
    assert (checkout / ".git").is_file()
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "data"))
    _assert_refused(_global_accesses(), checkout)


@pytest.mark.parametrize("marker", ["folder", "file"])
def test_a_git_marker_alone_decides_and_an_empty_git_folder_still_counts(tmp_path, monkeypatch, marker):
    """No git needed: a ``.git`` file (worktree, submodule) or folder, even an empty one Git itself would ignore."""
    checkout = _marked(tmp_path / "checkout", marker)
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "deep" / "data"))
    _assert_refused(_global_accesses(), checkout)


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_an_alias_into_a_checkout_is_judged_where_it_lands(tmp_path, monkeypatch, kind):
    checkout = _marked(tmp_path / "checkout")
    inside = checkout / "inner"
    inside.mkdir()
    alias = tmp_path / "innocent-looking-root"
    _plant(kind, alias, inside)
    monkeypatch.setenv("BUGPILOT_HOME", str(alias / "data"))
    _assert_refused(_global_accesses(), checkout)


def test_a_data_root_inside_the_working_tree_git_work_tree_names_is_refused(tmp_path, monkeypatch):
    tree = tmp_path / "work-tree"
    tree.mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(tree / "data"))
    monkeypatch.setenv(GIT_WORK_TREE_ENV, str(tree))
    _assert_refused(_global_accesses(), tree, match="the working tree GIT_WORK_TREE names")


def test_a_relative_git_work_tree_is_resolved_against_the_working_directory(tmp_path, monkeypatch):
    """As Git resolves it: ``GIT_WORK_TREE=work-tree`` means ``<working directory>/work-tree``."""
    (tmp_path / "work-tree").mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / "work-tree" / "data"))
    monkeypatch.setenv(GIT_WORK_TREE_ENV, "work-tree")
    _assert_refused(_global_accesses(), tmp_path / "work-tree", match="the working tree GIT_WORK_TREE names")
    monkeypatch.chdir(tmp_path / "work-tree")  # now it names work-tree/work-tree, which does not hold the data root
    assert global_storage().user_fix_modes_dir(create=True).is_dir()


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_git_work_tree_given_through_a_link_is_resolved(tmp_path, monkeypatch, kind):
    tree = tmp_path / "work-tree"
    tree.mkdir()
    link = tmp_path / "tree-alias"
    _plant(kind, link, tree)
    monkeypatch.setenv("BUGPILOT_HOME", str(tree / "data"))
    monkeypatch.setenv(GIT_WORK_TREE_ENV, str(link))
    _assert_refused(_global_accesses(), tree, match="the working tree GIT_WORK_TREE names")


@pytest.mark.parametrize("value", ["", "   "])
def test_a_blank_git_work_tree_counts_as_unset(tmp_path, monkeypatch, value):
    monkeypatch.setenv(GIT_WORK_TREE_ENV, value)
    assert global_storage().user_fix_modes_dir(create=True).is_dir()


def test_a_malformed_or_unresolvable_git_work_tree_refuses(tmp_path, monkeypatch):
    monkeypatch.setenv(GIT_WORK_TREE_ENV, str(tmp_path / "tree") + "\x01")
    _assert_refused(_global_accesses(), tmp_path, match="control or line-separator character")
    monkeypatch.setenv(GIT_WORK_TREE_ENV, "relative-tree")
    monkeypatch.setattr(storage, "_working_directory", lambda: None)  # os.getcwd() raised: the directory is gone
    _assert_refused(_global_accesses(), tmp_path, match="the working directory is gone")


def test_a_folder_above_the_data_root_that_cannot_be_examined_refuses_it(tmp_path, monkeypatch):
    """Fail closed: when a ``.git`` look fails for any reason but "not there", the data root is not used."""
    real_lstat = os.lstat

    def locked(path, *args, **kwargs):
        if Path(path).name == ".git":
            raise PermissionError(errno.EACCES, "permission denied")
        return real_lstat(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "lstat", locked)
    _assert_refused(_global_accesses(), tmp_path, match="cannot tell whether its data folder")


@pytest.mark.parametrize("name", ["data", "checkout-data", "checkout.git-data"])
def test_a_data_root_beside_a_checkout_and_a_repository_that_is_a_checkout_are_accepted(tmp_path, monkeypatch, name):
    """Only the data root is judged: BugPilot runs inside Git repositories all the time (US-D4)."""
    checkout = _marked(tmp_path / "checkout")
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / name))
    assert repository_storage(checkout).work_item_dir("JR-12345", create=True).is_dir()
    assert global_storage().user_instructions_file(create=True).parent.is_dir()


# --- fresh verdicts: request scopes and the stale-identity bypass (Batch 2A) ---------------------


def test_a_git_marker_made_later_is_seen_by_the_next_check_outside_a_scope(tmp_path, monkeypatch):
    holder = tmp_path / "holder"
    monkeypatch.setenv("BUGPILOT_HOME", str(holder / "data"))
    holder.mkdir()
    g = global_storage()
    g.user_fix_modes_dir(create=True)
    (holder / ".git").mkdir()
    with pytest.raises(StorageError, match="inside a Git working tree"):
        g.user_fix_modes_dir(create=False)


def test_within_one_request_scope_a_verdict_holds_and_the_next_scope_looks_again(tmp_path, monkeypatch):
    """The staleness a scope allows is bounded by the scope: the next one sees the new ``.git``."""
    holder = tmp_path / "holder"
    monkeypatch.setenv("BUGPILOT_HOME", str(holder / "data"))
    holder.mkdir()
    g = global_storage()
    with request_scope():
        g.user_fix_modes_dir(create=True)
        (holder / ".git").mkdir()
        assert g.user_fix_modes_dir(create=False).is_dir()  # judged once in this scope
    with request_scope():
        with pytest.raises(StorageError, match="inside a Git working tree"):
            g.user_fix_modes_dir(create=False)


def test_scopes_nest_and_end(tmp_path):
    assert storage._scope.get() is None
    with request_scope():
        outer = storage._scope.get()
        with request_scope():
            assert storage._scope.get() is outer  # an inner scope joins the outer one
        assert storage._scope.get() is outer
    assert storage._scope.get() is None


def _retarget(kind: str, link: Path, target: Path) -> None:
    try:
        os.unlink(link)
    except OSError:
        os.rmdir(link)  # a junction, or a directory symbolic link on Windows
    _plant(kind, link, target)


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_retargeted_root_never_reuses_the_old_namespace_to_bypass_containment(tmp_path, monkeypatch, kind):
    """The bypass the 2A preflight reproduced: a process keeps the spelling of its root (as MCP binds it once);
    the link is pointed at a folder that holds the data root; the next write must be refused, and nothing created."""
    outer = tmp_path / "outer"
    outer.mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(outer / "data"))
    first_repo = tmp_path / "first"
    first_repo.mkdir()
    bound = tmp_path / "bound-root"
    _plant(kind, bound, first_repo)
    repository_storage(bound).work_item_dir("JR-12345", create=True)
    _retarget(kind, bound, outer)
    before = _tree(outer)
    with pytest.raises(StorageError, match="will not keep its data inside this repository"):
        repository_storage(bound).work_item_dir("JR-12345", create=True)
    assert _tree(outer) == before


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_retargeted_root_gets_the_namespace_of_the_folder_it_now_names(tmp_path, kind):
    first_repo, second_repo = tmp_path / "first", tmp_path / "second"
    first_repo.mkdir()
    second_repo.mkdir()
    bound = tmp_path / "bound-root"
    _plant(kind, bound, first_repo)
    first = repository_storage(bound)
    first.work_item_dir("JR-12345", create=True)
    snapshot = _tree(first._directory)
    _retarget(kind, bound, second_repo)
    second = repository_storage(bound)
    assert second.identity == storage.repository_identity(second_repo)
    assert second.identity.repository_id != first.identity.repository_id
    second.work_item_dir("JR-12345", create=True)
    assert _tree(first._directory) == snapshot


def _same_size_foreign_record(namespace) -> bytes:
    """The record's own bytes with one character of its root changed: same size, another repository."""
    text = storage._record_text(namespace.identity)
    root = json.dumps(str(namespace.identity.root))[1:-1]
    swapped = root[:-1] + ("x" if root[-1] != "x" else "y")
    return text.replace(root, swapped).encode("ascii")


def test_a_record_rewritten_in_place_is_never_trusted_in_a_later_scope(repo):
    """Same size, same modification time, another root: the next scope reads it again and refuses."""
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        assert namespace.record_state() == "ok"
    record = namespace._record_file
    info = os.stat(record)
    record.write_bytes(_same_size_foreign_record(namespace))
    os.utime(record, ns=(info.st_atime_ns, info.st_mtime_ns))
    assert os.stat(record).st_size == info.st_size
    with request_scope():
        assert namespace.record_state() == "mismatch"
        with pytest.raises(storage.StorageIdentityError):
            namespace.work_item_dir("JR-12345", create=True)


def test_within_one_scope_a_record_that_changed_is_read_again(repo):
    """The scope remembers a record only together with its signature: a rewrite of another size is read and refused."""
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        assert namespace.record_state() == "ok"
        namespace._record_file.write_bytes(_same_size_foreign_record(namespace) + b"\n")
        assert namespace.record_state() == "mismatch"


@pytest.mark.skipif(not POSIX, reason="st_ctime is the metadata-change time on POSIX only; Windows reports creation")
def test_on_posix_an_in_place_rewrite_is_seen_even_within_one_scope(repo):
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        record = namespace._record_file
        info = os.stat(record)
        record.write_bytes(_same_size_foreign_record(namespace))
        os.utime(record, ns=(info.st_atime_ns, info.st_mtime_ns))
        assert namespace.record_state() == "mismatch"


# --- F4: the identity record is read and judged on every check (owner decision Option A) --------------------------


def _rewrite_keeping_size_and_time(namespace, payload: bytes) -> None:
    """The record rewritten in place, its size and modification time kept: nothing in its metadata shows it."""
    record = namespace._record_file
    info = os.stat(record)
    assert len(payload) == info.st_size
    record.write_bytes(payload)
    os.utime(record, ns=(info.st_atime_ns, info.st_mtime_ns))
    after = os.stat(record)
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _same_size_unreadable_record(namespace) -> bytes:
    """Bytes of the record's own size that are not a record at all."""
    return b"x" * len(storage._record_text(namespace.identity).encode("ascii"))


def _identity_refusal(namespace, state: str) -> str:
    shown = storage.display_path(namespace._record_file)
    if state == "mismatch":
        return (f"BugPilot will not use {shown}: it belongs to a different repository folder. "
                "Nothing was read or written; delete that record only if you are sure it is stale.")
    return (f"BugPilot will not use {shown}: it is not a readable repository record. "
            "Nothing was read or written; delete it to let BugPilot create it again.")


def test_an_in_place_rewrite_keeping_size_and_time_is_seen_within_one_scope_on_every_system(repo):
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        assert namespace.record_state() == "ok"
        _rewrite_keeping_size_and_time(namespace, _same_size_foreign_record(namespace))
        assert namespace.record_state() == "mismatch"


@pytest.mark.parametrize("state", ["mismatch", "corrupt"])
def test_a_record_rewritten_within_one_scope_refuses_every_namespace_operation_in_its_words(repo, state):
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        work = namespace.work_item_dir("JR-12345", create=True)
        assert namespace.record_state() == "ok"
        payload = _same_size_foreign_record(namespace) if state == "mismatch" else _same_size_unreadable_record(namespace)
        _rewrite_keeping_size_and_time(namespace, payload)

        for operation in (
            lambda: namespace.work_item_dir("JR-12345", create=False),  # a work item's path
            lambda: namespace.work_item_dir("JR-12345", create=True),  # a write: create=True goes through ensure()
            namespace.ensure,
            lambda: namespace.settings_file("instructions.md", create=False),
        ):
            with pytest.raises(storage.StorageIdentityError) as refused:
                operation()
            assert str(refused.value) == _identity_refusal(namespace, state)
            for place in (repo, data_root()):
                assert str(place) not in str(refused.value)
        why = "it belongs to a different repository folder" if state == "mismatch" else (
            "its identity record is not readable as one")
        with pytest.raises(StorageError) as refused:  # a delete
            namespace.remove_work_item("JR-12345")
        assert str(refused.value).endswith(f"cannot be shown to be this repository's ({why}). Nothing was deleted.")
        assert work.is_dir()


def test_a_record_removed_within_one_scope_is_missing_as_the_approved_policy_says(repo):
    namespace = repository_storage(repo)
    with request_scope():
        namespace.ensure()
        assert namespace.record_state() == "ok"
        namespace._record_file.unlink()
        assert namespace.record_state() == "missing-record"
        namespace.work_item_dir("JR-12345", create=False)  # a namespace without its record is not refused
        namespace.ensure()  # and ensure() publishes it again
        assert namespace.record_state() == "ok"


def test_a_record_in_use_is_still_retried_then_a_failure_never_a_verdict(repo, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    namespace = repository_storage(repo)
    namespace.ensure()
    real_read = storage._read_regular
    busy = {"left": 2}

    def read_regular(path, info):
        if busy["left"]:
            busy["left"] -= 1
            raise PermissionError(errno.EACCES, "in use")
        return real_read(path, info)

    monkeypatch.setattr(storage, "_read_regular", read_regular)
    with request_scope():
        assert namespace.record_state() == "ok"  # in use twice, retried, then read
        busy["left"] = 99
        with pytest.raises(storage.StorageUnavailable) as failed:
            namespace.record_state()
    assert "right now" in str(failed.value)
    for place in (repo, data_root()):
        assert str(place) not in str(failed.value)


def test_containment_and_git_verdicts_are_still_computed_once_per_scope(repo, monkeypatch):
    namespace = repository_storage(repo)
    namespace.ensure()
    git_judged, containment_looks = [], []
    real_git, real_within = storage._judge_git_tree, storage._physically_within
    monkeypatch.setattr(storage, "_judge_git_tree", lambda *args: git_judged.append(1) or real_git(*args))
    monkeypatch.setattr(storage, "_physically_within", lambda *args: containment_looks.append(1) or real_within(*args))
    with request_scope():
        for _ in range(3):
            namespace.record_state()
            namespace.work_item_dir("JR-12345", create=False)
        kinds = {key[0] for key in storage._active_scope()}
    assert {"containment", "git-tree"} <= kinds and "record" not in kinds
    assert git_judged == [1]
    assert len(containment_looks) == 2  # one judgement: both directions, once


# --- diagnostics: paths as text, nothing checked or created (Batch 2A) ----------------------------


def test_diagnostics_give_the_doctor_paths_and_create_nothing(tmp_path, monkeypatch):
    checkout = _marked(tmp_path / "checkout")  # a data root every accessor refuses: diagnostics still answer
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "data"))
    namespace = repository_storage(tmp_path)
    before = _tree(tmp_path)
    found = namespace.diagnostics()
    assert found == {
        "data_root": str(data_root()),
        "data_root_display": "BUGPILOT_HOME",
        "data_root_source": "BUGPILOT_HOME",
        "repository_root": str(Path(os.path.realpath(tmp_path))),
        "repository_id": namespace.identity.repository_id,
        "repository_dir": str(data_root() / "repositories" / namespace.identity.repository_id),
        "config_dir": str(data_root() / "config"),
    }
    assert global_storage().diagnostics() == {key: found[key] for key in ("data_root", "data_root_display",
                                                                          "data_root_source", "config_dir")}
    assert _tree(tmp_path) == before
    # The names are §8.10's doctor keys, from the frozen contract fixture.
    contract = json.loads((REPO / "tests" / "fixtures" / "storage_cli_contract.json").read_text(encoding="utf-8"))
    doctor_keys = {key for entry in contract["entries"] if entry["parent"] == "storage" for key in entry["keys"]}
    assert set(found) <= doctor_keys


# --- G-3: credentials only where they are private (Batch 2A) ---------------------------------------


def test_credentials_are_written_privately_where_the_folders_are_private():
    g = global_storage()
    path = g.write_config_file("jira_token = 'synthetic'\n")
    assert path == data_root() / "config" / storage.CREDENTIALS_NAME
    assert path.read_text(encoding="utf-8") == "jira_token = 'synthetic'\n"
    assert private_folder.verify_private(path, "credential-file").private
    if POSIX:
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(data_root() / "config").st_mode) & 0o077 == 0
    assert g.config_file(create=True) == path  # an existing private file passes too


@pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; the Windows access-list cases follow")
@pytest.mark.parametrize(
    "where, mode, reason",
    [("config", 0o750, "its group has access to it"), ("root", 0o770, "its group may write to it"),
     ("file", 0o644, "every other account has access to it")],
)
def test_a_place_that_is_not_private_refuses_credentials_and_its_bits_are_left_alone(where, mode, reason):
    g = global_storage()
    g.write_config_file("jira_token = 'first'\n")
    target = {"config": data_root() / "config", "root": data_root(), "file": data_root() / "config" / "config.toml"}[where]
    os.chmod(target, mode)
    try:
        with pytest.raises(StorageError, match="will not write credentials") as refused:
            g.write_config_file("jira_token = 'second'\n")
        assert reason in str(refused.value) and "second" not in str(refused.value)
        assert stat.S_IMODE(os.stat(target).st_mode) == mode  # never silently changed
        assert (data_root() / "config" / "config.toml").read_text(encoding="utf-8") == "jira_token = 'first'\n"
    finally:
        os.chmod(target, 0o700 if where != "file" else 0o600)


@pytest.mark.skipif(not WINDOWS, reason="Windows access lists")
@pytest.mark.parametrize("where", ["config", "file"])
def test_an_access_list_that_lets_others_in_refuses_credentials_and_is_left_alone(where):
    """Synthetic folders only: icacls adds a grant to ``tmp_path``'s own copies, never to anything else."""
    g = global_storage()
    g.write_config_file("jira_token = 'first'\n")
    target = data_root() / "config" if where == "config" else data_root() / "config" / "config.toml"
    grant = "*S-1-5-32-545:(OI)(CI)(RX)" if where == "config" else "*S-1-5-32-545:(R)"
    subprocess.run(["icacls", str(target), "/grant", grant], check=True, capture_output=True)
    before = private_folder._read_security(str(target))
    with pytest.raises(StorageError, match="will not write credentials") as refused:
        g.write_config_file("jira_token = 'second'\n")
    assert "Users has access to it" in str(refused.value) and "second" not in str(refused.value)
    assert private_folder._read_security(str(target)) == before  # never changed
    assert (data_root() / "config" / "config.toml").read_text(encoding="utf-8") == "jira_token = 'first'\n"


def _verdicts(monkeypatch, **by_role) -> None:
    """Make privacy answers per role, to test the gate's decisions independently of the platform."""

    def verify(path, role):
        return by_role.get(role.replace("-", "_"), private_folder.PrivacyVerdict("private"))

    monkeypatch.setattr(storage.private_folder, "verify_private", verify)


def test_an_unverifiable_place_refuses_credentials(monkeypatch):
    _verdicts(monkeypatch, config_folder=private_folder.PrivacyVerdict("unverifiable", ("its volume keeps no access lists",)))
    with pytest.raises(StorageError, match="cannot confirm that .* is private") as refused:
        global_storage().write_config_file("jira_token = 'never-shown'\n")
    assert "never-shown" not in str(refused.value)
    assert not (data_root() / "config" / "config.toml").exists()


def test_a_file_that_is_not_private_after_the_write_is_reported_and_never_echoed(monkeypatch):
    _verdicts(monkeypatch, credential_file=private_folder.PrivacyVerdict("not-private", ("Users has access to it",)))
    with pytest.raises(StorageError, match="cannot confirm that only your account can read it") as refused:
        global_storage().write_config_file("jira_token = 'never-shown'\n")
    assert "never-shown" not in str(refused.value) and "Users has access to it" in str(refused.value)


def test_only_the_credentials_file_is_privacy_gated(monkeypatch):
    """Instructions and Fix Modes are not credentials: written wherever the containment and link checks allow."""
    not_private = private_folder.PrivacyVerdict("not-private", ("Users has access to it",))
    _verdicts(monkeypatch, data_root=not_private, config_folder=not_private)
    g = global_storage()
    assert g.user_instructions_file(create=True).parent.is_dir()
    assert g.user_fix_modes_dir(create=True).is_dir()
    assert g.config_file(create=False).name == storage.CREDENTIALS_NAME  # a read checks no privacy
    with pytest.raises(StorageError, match="will not write credentials"):
        g.config_file(create=True)


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_at_the_credentials_file_is_refused_for_reads_and_writes(decoy, kind):
    g = global_storage()
    g.ensure_config_dir()
    _plant("symlink" if kind == "symlink" else "junction", data_root() / "config" / "config.toml", decoy)
    for access in (lambda: g.config_file(create=False), lambda: g.write_config_file("jira_token = 'x'\n")):
        with pytest.raises(StorageError, match="symbolic link or junction"):
            access()
    assert sorted(os.listdir(decoy)) == ["keep.txt"]


def test_the_resolver_timing_is_recorded_for_ci(tmp_path):
    """§12, measured and recorded, never asserted: timings vary by machine, and the test guard adds its own cost.

    CI's safety jobs set ``BUGPILOT_BASELINE_OUT``, and their report publishes
    the record as an annotation, so each platform's numbers are visible.
    """
    import platform
    import statistics
    import time

    def median_us(action, runs, before=None):
        samples = []
        for index in range(runs):
            if before:
                before(index)
            start = time.perf_counter_ns()
            action(index)
            samples.append(time.perf_counter_ns() - start)
        return round(statistics.median(samples) / 1000, 1)

    roots = []
    for index in range(30):
        root = tmp_path / f"timing-{index:02d}"
        root.mkdir()
        roots.append(root)
    cold = median_us(lambda i: storage.repository_identity(roots[i]), 30, before=lambda i: _forget())
    warm = median_us(lambda i: storage.repository_identity(roots[0]), 2000)  # a cached hit, re-checked (Batch 2A)
    first_ensure = median_us(lambda i: repository_storage(roots[i]).ensure(), 30)
    repeat_ensure = median_us(lambda i: repository_storage(roots[0]).ensure(), 300)
    read_lookup = median_us(lambda i: repository_storage(roots[0]).work_item_dir("JR-12345", create=False), 500)
    with request_scope():
        scoped_lookup = median_us(lambda i: repository_storage(roots[0]).work_item_dir("JR-12345", create=False), 500)
    git_tree = median_us(lambda i: storage._git_tree_problem(data_root()), 500)
    global_storage().ensure_config_dir()
    privacy = median_us(lambda i: private_folder.verify_private(data_root() / "config", "config-folder"), 300)
    record = {
        "platform": sys.platform,
        "python": platform.python_version(),
        "guarded": True,
        "identity_cold_us": cold,
        "identity_warm_us": warm,
        "ensure_first_write_us": first_ensure,
        "ensure_repeat_us": repeat_ensure,
        "read_lookup_us": read_lookup,
        "read_lookup_in_scope_us": scoped_lookup,
        "git_tree_check_us": git_tree,
        "privacy_check_us": privacy,
        "budgets": "identity < 1 ms cold, < 10 us warm; first ensure() < 10 ms on Windows NTFS and 2 ms on "
        "Linux and macOS, a provisional reference (plan §12, Q6); read lookups judged end to end in Batch 2B",
    }
    out = os.environ.get("BUGPILOT_BASELINE_OUT")
    if out:
        directory = Path(out)
        directory.mkdir(parents=True, exist_ok=True)
        name = f"storage_timing_{sys.platform}_py{sys.version_info.major}{sys.version_info.minor}.json"
        (directory / name).write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    assert all(value > 0 for key, value in record.items() if key.endswith("_us"))


def test_the_module_imports_on_its_own():
    """Standard library only: importing it pulls in no third-party package."""
    import subprocess

    code = (
        "import sys, bugpilot.core.storage as s; "
        "third = sorted(m for m in sys.modules if m.split('.')[0] in ('requests', 'mcp', 'yaml', 'httpx')); "
        "print(third)"
    )
    done = subprocess.run(
        [sys.executable, "-c", code],
        env=dict(os.environ, PYTHONPATH=_isolation.child_pythonpath(REPO)),
        capture_output=True, text=True, timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "[]"


# --- checked deletion: the storage side of ``clean`` (Batch 2B-1) --------------------------------------
# Only ``work/<id>`` and ``memory/<id>.md`` can be addressed, through validated ids. Everything is made
# in this test's own BUGPILOT_HOME and ``tmp_path``; links point at the decoy, which must stay as it was.


def _one_sentence(error: BaseException) -> None:
    """A deletion refusal names its target relative to the namespace (``work/<id>``), never a full path."""
    message = str(error)
    assert "\n" not in message
    assert "Nothing was deleted" in message or "may remain" in message
    assert str(data_root()) not in message and str(Path.home()) not in message


def _work_item(namespace, work_item_id: str = "JR-12345") -> Path:
    work = namespace.work_item_dir(work_item_id, create=True)
    (work / "task.md").write_text("synthetic\n", encoding="utf-8")
    (work / "attachments").mkdir()
    (work / "attachments" / "a.txt").write_text("synthetic\n", encoding="utf-8")
    return work


def _memory(namespace, work_item_id: str = "JR-12345") -> Path:
    path = namespace.memory_file(work_item_id, create=True)
    path.write_text("synthetic\n", encoding="utf-8")
    return path


def _populated(namespace) -> None:
    """A namespace holding one of everything, and the global configuration."""
    _work_item(namespace)
    _work_item(namespace, "JR-2")
    _memory(namespace)
    _memory(namespace, "JR-2")
    namespace.settings_file("verification.md", create=True).write_text("synthetic\n", encoding="utf-8")
    namespace.fix_modes_dir(create=True)
    global_storage().write_config_file("jira_base_url = 'https://jira.example.invalid'\n")


def test_removing_a_work_item_deletes_that_folder_and_nothing_else(repo):
    namespace = repository_storage(repo)
    _populated(namespace)
    before = _tree(data_root())
    assert namespace.remove_work_item("JR-12345") is True
    prefix = f"repositories/{namespace.identity.repository_id}/work/JR-12345"
    assert sorted(set(before) - set(_tree(data_root()))) == sorted(
        path for path in before if path == prefix or path.startswith(prefix + "/"))
    after = _tree(data_root())
    assert set(after) <= set(before)
    assert namespace.remove_work_item("JR-12345") is False  # already gone: nothing to do
    assert _tree(data_root()) == after


def test_removing_a_memory_file_deletes_that_file_and_nothing_else(repo):
    namespace = repository_storage(repo)
    _populated(namespace)
    before = _tree(data_root())
    assert namespace.remove_memory_file("JR-12345") is True
    after = _tree(data_root())
    assert set(after) <= set(before)
    assert sorted(set(before) - set(after)) == [
        f"repositories/{namespace.identity.repository_id}/memory/JR-12345.md"]
    assert namespace.remove_memory_file("JR-12345") is False


def test_removing_from_a_namespace_that_was_never_made_creates_nothing(repo):
    root_existed = os.path.lexists(data_root())
    before = _tree(data_root())
    namespace = repository_storage(repo)
    assert namespace.remove_work_item("JR-12345") is False
    assert namespace.remove_memory_file("JR-12345") is False
    assert os.path.lexists(data_root()) == root_existed and _tree(data_root()) == before


@pytest.mark.parametrize(
    "work_item_id",
    ["", ".", "..", "../settings", "settings", "config", "work", "memory", "repository.json",
     "JR-1/../../settings", "JR-1\\..\\..", "C:", "/JR-1", "JR-1 ", "JR-1\0"],
)
def test_an_id_that_is_not_a_work_item_id_deletes_nothing(repo, work_item_id):
    """Never the data root, ``config``, the namespace, ``settings``, ``work`` or ``memory``: no id reaches them."""
    namespace = repository_storage(repo)
    _populated(namespace)
    before = _tree(data_root())
    for remove in (namespace.remove_work_item, namespace.remove_memory_file):
        with pytest.raises(StorageError):
            remove(work_item_id)
    assert _tree(data_root()) == before


#: where a link is planted, below the namespace (``()``: the namespace itself); the removal that must refuse
DELETION_LINKS = {
    "work/<id>": (("work", "JR-12345"), "work"),
    "work": (("work",), "work"),
    "memory": (("memory",), "memory"),
    "<id>": ((), "work"),
}


@pytest.mark.parametrize("kind", LINK_KINDS)
@pytest.mark.parametrize("where", list(DELETION_LINKS))
def test_a_link_on_the_way_to_what_is_deleted_refuses_and_the_target_is_untouched(repo, decoy, kind, where):
    namespace = repository_storage(repo)
    namespace.ensure()
    rest, which = DELETION_LINKS[where]
    (decoy / "JR-12345").mkdir()  # what a followed link would delete
    (decoy / "JR-12345" / "task.md").write_text("decoy\n", encoding="utf-8")
    (decoy / "JR-12345.md").write_text("decoy\n", encoding="utf-8")
    shutil.copyfile(namespace._record_file, decoy / storage.RECORD_NAME)  # even a valid record behind the link
    link = namespace._directory.joinpath(*rest)
    if not rest:
        shutil.rmtree(link)
    _plant(kind, link, decoy)
    before = _tree(decoy)
    remove = namespace.remove_work_item if which == "work" else namespace.remove_memory_file
    with pytest.raises(StorageError, match="symbolic link or junction") as refused:
        remove("JR-12345")
    _one_sentence(refused.value)
    assert _tree(decoy) == before and os.path.lexists(link)


def test_a_link_at_the_memory_file_itself_is_refused(repo, decoy):
    namespace = repository_storage(repo)
    folder = namespace.memory_file("JR-12345", create=True).parent
    try:
        os.symlink(decoy / "keep.txt", folder / "JR-12345.md")
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"file symbolic links are not available here: {type(error).__name__}")
    with pytest.raises(StorageError, match="symbolic link or junction"):
        namespace.remove_memory_file("JR-12345")
    assert (decoy / "keep.txt").read_text(encoding="utf-8") == "decoy\n"
    assert os.path.lexists(folder / "JR-12345.md")


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_inside_a_work_folder_is_removed_as_a_link_never_followed(repo, decoy, kind):
    namespace = repository_storage(repo)
    work = _work_item(namespace)
    _plant(kind, work / "escape", decoy)
    before = _tree(decoy)
    assert namespace.remove_work_item("JR-12345") is True
    assert not os.path.lexists(work) and _tree(decoy) == before


@pytest.mark.parametrize("record", ["missing", "another repository", "unreadable"])
def test_a_namespace_not_shown_to_be_this_repositorys_deletes_nothing(repo, record):
    """One repository can never delete another's files: the record must be this repository's."""
    namespace = repository_storage(repo)
    _populated(namespace)
    if record == "missing":
        namespace._record_file.unlink()
    elif record == "another repository":
        namespace._record_file.write_bytes(_same_size_foreign_record(namespace))
    else:
        namespace._record_file.write_text("not a record\n", encoding="utf-8")
    before = _tree(data_root())
    for remove in (namespace.remove_work_item, namespace.remove_memory_file):
        with pytest.raises(StorageError, match="Nothing was deleted") as refused:
            remove("JR-12345")
        _one_sentence(refused.value)
    assert _tree(data_root()) == before


def test_a_data_root_kept_with_the_repository_deletes_nothing(repo, monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", str(repo / ".bugpilot-data"))
    before = _tree(repo)
    namespace = repository_storage(repo)
    for remove in (namespace.remove_work_item, namespace.remove_memory_file):
        with pytest.raises(StorageError, match="inside this repository"):
            remove("JR-12345")
    assert _tree(repo) == before


def test_a_data_root_that_is_now_inside_a_git_working_tree_deletes_nothing(repo, tmp_path, monkeypatch):
    (tmp_path / "outer").mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / "outer" / "data"))
    namespace = repository_storage(repo)
    _work_item(namespace)
    (tmp_path / "outer" / ".git").mkdir()  # the data root's parent became a checkout since
    before = _tree(data_root())
    with pytest.raises(StorageError, match="inside a Git working tree"):
        namespace.remove_work_item("JR-12345")
    assert _tree(data_root()) == before


def test_a_target_of_the_wrong_kind_deletes_nothing(repo):
    namespace = repository_storage(repo)
    memory = namespace.memory_file("JR-12345", create=True)
    work = namespace._directory / "work" / "JR-12345"
    work.parent.mkdir()
    work.write_text("a file where a work folder belongs\n", encoding="utf-8")
    memory.mkdir()
    with pytest.raises(StorageError, match="not a folder"):
        namespace.remove_work_item("JR-12345")
    with pytest.raises(StorageError, match="not a regular file"):
        namespace.remove_memory_file("JR-12345")
    assert work.is_file() and memory.is_dir()


def test_a_target_that_does_not_resolve_to_its_own_place_deletes_nothing(repo, monkeypatch):
    namespace = repository_storage(repo)
    work = _work_item(namespace)
    real = os.path.realpath
    resolved_work = os.path.normcase(real(work))

    def elsewhere(path, *args, **kwargs):
        resolved = real(path, *args, **kwargs)
        return resolved + "-elsewhere" if os.path.normcase(resolved) == resolved_work else resolved

    monkeypatch.setattr(storage.os.path, "realpath", elsewhere)
    with pytest.raises(StorageError, match="does not resolve to its own place"):
        namespace.remove_work_item("JR-12345")
    monkeypatch.undo()
    assert (work / "task.md").exists()


def test_legacy_data_in_the_repository_is_never_touched(repo):
    for relative in (".ai/work/JR-12345/task.md", ".ai_memory/JR-12345.md", ".bugpilot/project_settings.json"):
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        (repo / relative).write_text("legacy\n", encoding="utf-8")
    before = _tree(repo)
    namespace = repository_storage(repo)
    assert namespace.remove_work_item("JR-12345") is False
    assert namespace.remove_memory_file("JR-12345") is False
    _work_item(namespace)
    _memory(namespace)
    assert namespace.remove_work_item("JR-12345") is True
    assert namespace.remove_memory_file("JR-12345") is True
    assert _tree(repo) == before


def test_a_target_that_cannot_be_examined_is_unavailable_not_refused(repo, monkeypatch):
    namespace = repository_storage(repo)
    work = _work_item(namespace)
    real = os.lstat

    def denied(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(work):
            raise PermissionError(errno.EACCES, "denied")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "lstat", denied)
    with pytest.raises(storage.StorageUnavailable, match="cannot examine") as unavailable:
        namespace.remove_work_item("JR-12345")
    _one_sentence(unavailable.value)
    monkeypatch.undo()
    assert (work / "task.md").exists()


@pytest.mark.skipif(not WINDOWS, reason="a file held open blocks its deletion on Windows only")
def test_a_deletion_stopped_by_a_file_in_use_reports_it_and_can_be_retried(repo):
    namespace = repository_storage(repo)
    work = _work_item(namespace)
    with open(work / "task.md", "rb"):
        with pytest.raises(storage.StorageUnavailable, match="could not finish deleting") as unavailable:
            namespace.remove_work_item("JR-12345")
    _one_sentence(unavailable.value)
    assert "may remain" in str(unavailable.value)
    assert namespace.remove_work_item("JR-12345") is True
    assert not os.path.lexists(work)


def test_a_deletion_that_fails_part_way_is_unavailable_with_no_path_shown(repo, monkeypatch):
    namespace = repository_storage(repo)
    _work_item(namespace)

    def interrupted(path):
        raise PermissionError(errno.EACCES, "denied", str(path))

    monkeypatch.setattr(storage, "remove_owned_path", interrupted)
    with pytest.raises(storage.StorageUnavailable) as unavailable:
        namespace.remove_work_item("JR-12345")
    _one_sentence(unavailable.value)


# --- diagnostics that never raise (Batch 2B-1) -----------------------------------------------------------


def _quietly(check):
    """``check()``, which must neither raise nor create, write or change anything under the data root."""
    from _storage_witness import witness

    root_existed, before = os.path.lexists(data_root()), _tree(data_root())
    with witness() as observed:
        found = check()
    assert observed.observations == [] and observed.errors == []
    assert os.path.lexists(data_root()) == root_existed and _tree(data_root()) == before
    assert isinstance(found, storage.StorageCheck)
    if found.problem is not None:
        assert "\n" not in found.problem
        assert str(data_root()) not in found.problem and str(Path.home()) not in found.problem
    return found


def test_global_check_reports_uninitialized_then_usable():
    assert _quietly(global_storage().check) == storage.StorageCheck("uninitialized")
    global_storage().write_config_file("jira_base_url = 'https://jira.example.invalid'\n")
    assert _quietly(global_storage().check) == storage.StorageCheck("usable")


def test_repository_check_reports_uninitialized_then_usable(repo):
    namespace = repository_storage(repo)
    assert _quietly(namespace.check) == storage.StorageCheck("uninitialized")
    namespace.ensure()
    assert _quietly(namespace.check) == storage.StorageCheck("usable")
    namespace._record_file.unlink()
    assert _quietly(namespace.check).state == "uninitialized"  # the next write publishes it again


@pytest.mark.parametrize("record", ["another repository", "unreadable"])
def test_repository_check_reports_a_foreign_or_unreadable_record_as_refused(repo, record):
    namespace = repository_storage(repo)
    namespace.ensure()
    namespace._record_file.write_bytes(
        _same_size_foreign_record(namespace) if record == "another repository" else b"not a record\n")
    found = _quietly(namespace.check)
    assert found.state == "refused"
    assert ("different repository folder" if record == "another repository" else "not a readable") in found.problem


def test_checks_report_a_data_root_in_a_git_working_tree_as_refused(repo, tmp_path, monkeypatch):
    checkout = _marked(tmp_path / "git-checkout")
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "data"))
    for check in (global_storage().check, repository_storage(repo).check):
        found = _quietly(check)
        assert found.state == "refused" and "inside a Git working tree" in found.problem
    assert _tree(checkout) == [".git"]


def test_repository_check_reports_a_data_root_in_the_repository_as_refused(repo, monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", str(repo / ".bugpilot-data"))
    found = _quietly(repository_storage(repo).check)
    assert found.state == "refused" and "inside this repository" in found.problem


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_checks_report_a_link_on_the_way_as_refused(repo, decoy, kind):
    namespace = repository_storage(repo)
    storage._ensure_root(data_root())
    _plant(kind, data_root() / "config", decoy)
    _plant(kind, data_root() / "repositories", decoy)
    for check in (global_storage().check, namespace.check):
        found = _quietly(check)
        assert found.state == "refused" and "symbolic link or junction" in found.problem
    assert _tree(decoy) == ["keep.txt"]


def test_global_check_reports_a_place_that_is_not_private_as_refused(monkeypatch):
    global_storage().write_config_file("jira_token = 'never-shown'\n")
    _verdicts(monkeypatch, config_folder=private_folder.PrivacyVerdict("not-private", ("Users has access to it",)))
    found = _quietly(global_storage().check)
    assert found.state == "refused" and "Users has access to it" in found.problem
    assert "never-shown" not in found.problem


def test_global_check_reports_privacy_it_cannot_prove_as_unverifiable(monkeypatch):
    storage._ensure_root(data_root())
    _verdicts(monkeypatch, data_root=private_folder.PrivacyVerdict("unverifiable", ("its volume keeps no access lists",)))
    found = _quietly(global_storage().check)
    assert found.state == "unverifiable" and "its volume keeps no access lists" in found.problem


def test_checks_report_a_file_system_that_does_not_answer_as_unavailable(repo, monkeypatch):
    namespace = repository_storage(repo)
    namespace.ensure()
    global_storage().ensure_config_dir()
    real = os.lstat

    def denied(path, *args, **kwargs):
        if Path(path).name in ("config", storage.RECORD_NAME):
            raise PermissionError(errno.EACCES, "denied")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    monkeypatch.setattr(storage.os, "lstat", denied)
    for check in (global_storage().check, namespace.check):
        found = _quietly(check)
        assert found.state == "unavailable", found
