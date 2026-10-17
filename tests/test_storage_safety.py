"""Storage safety primitives: links, modes, containment and traversal (0.1.6 Batch 1, plan §8.3, §8.5, §10.2, §11.3).

The primitives only: no product module uses ``bugpilot.core.storage`` yet, so
the end-to-end cases (atomic writes on the new tree, CLI and MCP isolation,
``clean``) come with Batch 2. Every test runs in Batch 0A's isolation, with a
fresh ``BUGPILOT_HOME`` inside the session; links point at a decoy folder in
``tmp_path`` that the assertions show was never written.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import sys
from pathlib import Path

import pytest

import _isolation
from bugpilot.core import safe_paths, storage
from bugpilot.core.safe_paths import UnsafePathError, refuse_link, writable_dir
from bugpilot.core.storage import StorageError, data_root, global_storage, repository_storage

REPO = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
POSIX = os.name == "posix"


def _forget() -> None:
    """Forget memoized identities and verified records, as a fresh process would."""
    storage._identity.cache_clear()
    storage._verified.clear()


@pytest.fixture(autouse=True)
def fresh_caches():
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
    _plant(kind, namespace.settings_dir, decoy)
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
    _plant(LINK_KINDS[-1], namespace.work_root / "JR-2", decoy)
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
    assert folder.parent == namespace.work_root
    assert os.path.realpath(folder).startswith(os.path.realpath(namespace.directory))


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
    assert storage._containment_problem(namespace.root, namespace.identity) == "inside"


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
    return [name for name in os.listdir(namespace.directory) if name.endswith(".tmp")]


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
    assert namespace.record_file.read_text(encoding="utf-8") == conflicting
    assert _leftover_temps(namespace) == []


def test_without_hard_links_posix_refuses_rather_than_risk_a_replacement(repo, monkeypatch, no_replace):
    """POSIX has no rename that refuses to replace: BugPilot refuses instead, and writes nothing."""
    _no_hard_links(monkeypatch)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace = repository_storage(repo)
    with pytest.raises(StorageError, match="has no hard links") as refused:
        namespace.ensure()
    assert str(data_root()) not in str(refused.value)
    assert not namespace.record_file.exists()
    assert _leftover_temps(namespace) == []


def test_without_hard_links_an_existing_record_is_untouched(repo, monkeypatch, no_replace):
    namespace = repository_storage(repo)
    namespace.ensure()
    before = namespace.record_file.read_bytes()
    _no_hard_links(monkeypatch)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace.ensure()  # an existing valid record: nothing to publish
    storage._verified.clear()
    namespace.ensure()  # verified again from disk: still nothing written
    assert namespace.record_file.read_bytes() == before


def test_another_link_failure_is_not_disguised_as_missing_hard_links(repo, monkeypatch, no_replace):
    def link(*args, **kwargs):
        raise OSError(errno.EACCES, "permission denied")

    monkeypatch.setattr(storage.os, "link", link)
    monkeypatch.setattr(storage, "_RENAME_NEVER_REPLACES", False)
    namespace = repository_storage(repo)
    with pytest.raises(OSError) as failed:
        namespace.ensure()
    assert not isinstance(failed.value, StorageError) and failed.value.errno == errno.EACCES
    assert not namespace.record_file.exists()


def test_a_refused_temp_file_name_publishes_nothing(repo, monkeypatch, no_replace):
    def refuse(handle, temp, path):
        raise safe_paths.UnsafePathError("BugPilot cannot write repository.json: its temporary file's name was a link.")

    monkeypatch.setattr(storage, "_check_temp", refuse)
    namespace = repository_storage(repo)
    with pytest.raises(StorageError, match="temporary file"):
        namespace.ensure()
    assert not namespace.record_file.exists()
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
    storage._verified.clear()
    real_open = os.open
    attempts = {"count": 0}

    def busy_twice(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(namespace.record_file):
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
    before = namespace.record_file.read_bytes()
    storage._verified.clear()
    real_open = os.open

    def always_locked(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(namespace.record_file):
            raise PermissionError(13, "sharing violation")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "open", always_locked)
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    for access in (namespace.ensure, namespace.record_state, lambda: namespace.work_item_dir("JR-1", create=False)):
        with pytest.raises(StorageError, match="cannot read .* right now") as refused:
            access()
        assert not isinstance(refused.value, storage.StorageIdentityError)
        assert "delete" not in str(refused.value) and str(data_root()) not in str(refused.value)
    assert namespace.record_file.read_bytes() == before


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
    (namespace.directory / "work").write_text("not a folder", encoding="utf-8")
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
        namespace.directory,
        namespace.work_root,
        namespace.work_root / "JR-12345",
        global_storage().config_dir,
    ]
    for folder in created:
        protected, entries = _dacl(folder)
        assert protected, folder.name
        assert entries == OWNER_ONLY, (folder.name, entries)
    # The record inherits the same three entries from its folder.
    assert _dacl(namespace.record_file)[1] == OWNER_ONLY


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
    warm = median_us(lambda i: storage.repository_identity(roots[0]), 2000)
    first_ensure = median_us(lambda i: repository_storage(roots[i]).ensure(), 30)
    read_lookup = median_us(lambda i: repository_storage(roots[0]).work_item_dir("JR-12345", create=False), 500)
    record = {
        "platform": sys.platform,
        "python": platform.python_version(),
        "guarded": True,
        "identity_cold_us": cold,
        "identity_warm_us": warm,
        "ensure_first_write_us": first_ensure,
        "read_lookup_us": read_lookup,
        "budgets": "identity < 1 ms cold, < 10 us warm; ensure() < 2 ms on the first write (plan §12)",
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
