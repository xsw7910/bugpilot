"""The storage resolver: the data root, repository identity and the identity record (0.1.6 Batch 1, plan §7, §8, §11.3).

Every test runs inside Batch 0A's isolation: ``BUGPILOT_HOME`` is a fresh
folder inside the session for each test, and the guard refuses any access to
the developer's real BugPilot data. Repositories are synthetic folders in
``tmp_path``. Nothing here is used by a product module yet (no caller is
switched in Batch 1).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

import _isolation
from bugpilot.core import storage
from bugpilot.core.storage import (
    REPOSITORY_ID_RE,
    StorageError,
    StorageIdentityError,
    data_root,
    data_root_source,
    display_path,
    global_storage,
    repository_id_for,
    repository_identity,
    repository_storage,
)

REPO = Path(__file__).resolve().parents[1]
PLAN = REPO / "docs" / "bugpilot_0.1.6_unified_storage_plan.md"
CONTRACT = REPO / "tests" / "fixtures" / "storage_cli_contract.json"
WINDOWS = os.name == "nt"


def _forget() -> None:
    """Forget memoized identities, as a fresh process would (verdicts live only within a request scope)."""
    storage._identities.clear()


@pytest.fixture(autouse=True)
def fresh_caches(monkeypatch):
    monkeypatch.delenv(storage.GIT_WORK_TREE_ENV, raising=False)  # a developer's own setting must not decide these
    _forget()
    yield
    _forget()


def _repo(base: Path, *parts: str) -> Path:
    path = base.joinpath(*parts)
    path.mkdir(parents=True)
    return path


def _snapshot(root: Path) -> dict[str, object]:
    """Every entry under ``root`` (links as links): a folder, a link, or a file's bytes and mtime."""
    if not os.path.lexists(root):
        return {}
    entries: dict[str, object] = {}
    for current, folders, files in os.walk(root):
        for name in folders + files:
            path = Path(current, name)
            relative = path.relative_to(root).as_posix()
            if os.path.islink(path) or (WINDOWS and storage.is_link_or_junction(path)):
                entries[relative] = "link"
            elif path.is_dir():
                entries[relative] = ("dir", os.stat(path).st_mtime_ns)
            else:
                entries[relative] = (path.read_bytes(), os.stat(path).st_mtime_ns)
    return entries


def _symlink_dir(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symbolic links are not available here: {type(error).__name__}")


def _junction(link: Path, target: Path) -> None:
    import _winapi

    _winapi.CreateJunction(str(target), str(link))


# --- the data root ------------------------------------------------------------------------------


def _canonical(path: Path) -> Path:
    return Path(os.path.realpath(path))


def test_the_default_data_root_is_the_home_folders_bugpilot_inside_the_test_isolation(monkeypatch):
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)
    assert data_root() == _canonical(Path.home() / ".bugpilot")
    assert data_root_source() == "default"
    session = os.path.normcase(os.path.realpath(_isolation.session_root()))
    assert os.path.normcase(str(data_root())).startswith(session)


def test_bugpilot_home_names_the_whole_data_root(monkeypatch, tmp_path):
    chosen = tmp_path / "chosen-root"
    monkeypatch.setenv("BUGPILOT_HOME", f"  {chosen}  ")
    assert data_root() == _canonical(chosen)
    assert data_root_source() == "BUGPILOT_HOME"
    assert Path(global_storage().diagnostics()["config_dir"]) == _canonical(chosen) / "config"


def test_the_data_root_is_canonical(monkeypatch, tmp_path):
    """Review finding L7: ``..`` (and, where they exist, links) resolved, as §8.10's ``abs`` values require."""
    (tmp_path / "a").mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / "a" / ".." / "root"))
    assert data_root() == _canonical(tmp_path / "root")
    assert ".." not in data_root().parts
    assert display_path(data_root() / "config") == "BUGPILOT_HOME/config"
    assert display_path(tmp_path / "a" / ".." / "root" / "config") == "BUGPILOT_HOME/config"  # as configured


def test_a_blank_bugpilot_home_counts_as_unset(monkeypatch):
    monkeypatch.setenv("BUGPILOT_HOME", "   ")
    assert data_root() == _canonical(Path.home() / ".bugpilot")
    assert data_root_source() == "default"


def test_display_paths_are_cut_by_components_even_when_folding_changes_length(monkeypatch):
    """Review finding L2: a fold that lengthens a component must not shift the shown part."""
    def lengthening(text: str) -> str:
        return text.lower().replace("İ", "i̇")  # Python 3.10/3.11's str.lower of a Turkish dotted I

    monkeypatch.setattr(storage.os.path, "normcase", lengthening)
    base = os.path.join(os.path.abspath(os.sep), "Users", "İlker", ".bugpilot")
    target = os.path.join(base, "repositories", "app-0123456789abcdef", "work", "JR-12345")
    assert storage._parts_below(target, base) == ["repositories", "app-0123456789abcdef", "work", "JR-12345"]
    assert storage._parts_below(os.path.join(os.path.abspath(os.sep), "Users", "other"), base) is None


@pytest.mark.parametrize("value", ["relative/root", "./root", "~/bugpilot", "~", "bugpilot"])
def test_a_relative_or_tilde_bugpilot_home_is_refused(monkeypatch, value):
    monkeypatch.setenv("BUGPILOT_HOME", value)
    with pytest.raises(StorageError) as refused:
        data_root()
    # One fixed sentence: the value itself is never echoed.
    assert str(refused.value) == "BUGPILOT_HOME must be an absolute path. A leading ~ is not expanded; write the full path."


@pytest.mark.parametrize("character", ["\n", "\r", "\t", "\x1b", "\x7f", "\x85", "\x9f", "\u2028", "\u2029"])
def test_a_control_or_line_separator_in_bugpilot_home_is_refused(monkeypatch, tmp_path, character):
    monkeypatch.setenv("BUGPILOT_HOME", f"{tmp_path}{os.sep}a{character}b")
    with pytest.raises(StorageError, match="control or line-separator"):
        data_root()


def test_nul_is_refused_too():
    # A process environment cannot hold NUL on these systems; the pattern refuses it all the same.
    assert storage._FORBIDDEN_IN_ROOT.search("/x\x00y")


def test_a_missing_or_relative_home_is_refused_not_guessed(monkeypatch):
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)

    def no_home():
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(storage.Path, "home", staticmethod(no_home))
    with pytest.raises(StorageError, match="home folder"):
        data_root()
    monkeypatch.setattr(storage.Path, "home", staticmethod(lambda: Path("relative-home")))
    with pytest.raises(StorageError, match="home folder"):
        data_root()


# --- the algorithm (§7.2): golden vectors, on every operating system --------------------------

#: Fixed paths and their IDs. A change here is a change of algorithm: it needs an owner decision.
GOLDEN = [
    ("/home/you/src/checkout", False, "checkout-16f9432d5af86ec5"),
    ("C:\\Users\\you\\src\\Checkout", True, "checkout-9162ffe8034ca234"),
]


@pytest.mark.parametrize("canonical, windows, expected", GOLDEN)
def test_golden_vectors_pin_the_algorithm_on_every_os(canonical, windows, expected):
    assert repository_id_for(canonical, windows=windows) == expected


@pytest.mark.parametrize("canonical, windows, expected", GOLDEN)
def test_the_golden_vectors_follow_section_7_2_exactly(canonical, windows, expected):
    """An independent restatement of §7.2: a versioned SHA-256 domain, then the first 16 hex digits."""
    key = canonical.replace("/", "\\").lower() if windows else canonical
    digest = hashlib.sha256(b"bugpilot-repository-v1\x00" + key.encode("utf-8")).hexdigest()
    assert expected == f"checkout-{digest[:16]}"


def test_windows_keys_fold_case_and_separators_and_posix_keys_do_not():
    assert repository_id_for("c:/users/YOU/src/checkout", windows=True) == "checkout-9162ffe8034ca234"
    assert repository_id_for("/home/you/src/Checkout", windows=False) != "checkout-16f9432d5af86ec5"


HOSTILE_BASENAMES = [
    "line\nbreak",
    "..",
    ".",
    "CON",
    "nul.txt",
    "aux.x",
    "trailing.",
    "trailing ",
    "\U0001f600\U0001f680",
    "\u202eevil.exe",
    "a" * 300,
    "日本語のリポジトリ",
    "Ünïcödé Café",
    "_leading_underscore",
    "-dash-.",
    "semi;colon$(x)`y`&|>",
]


@pytest.mark.parametrize("basename", HOSTILE_BASENAMES)
@pytest.mark.parametrize("windows", [False, True])
def test_every_hostile_basename_gives_a_valid_harmless_id(basename, windows):
    canonical = ("C:\\work\\" if windows else "/work/") + basename
    repository_id = repository_id_for(canonical, windows=windows)
    assert REPOSITORY_ID_RE.fullmatch(repository_id), repository_id
    slug = repository_id[:-17]
    assert 1 <= len(slug) <= 24
    assert re.fullmatch(r"[a-z0-9][a-z0-9._-]*", slug)


@pytest.mark.parametrize(
    "canonical, windows",
    [
        ("C:\\Users\\you", True),
        ("D:\\USERS\\User", True),
        ("/home/dev", False),
        ("/Users/you", False),
        ("/root", False),
    ],
)
def test_a_profile_folder_never_puts_the_account_name_in_the_id(canonical, windows):
    """Review finding L3 (US-D22): a repository that is a user's profile folder gets the slug ``home``.

    The account names are the publishability guard's generic ones; none can occur in a hex digest.
    """
    repository_id = repository_id_for(canonical, windows=windows)
    account = canonical.replace("\\", "/").rsplit("/", 1)[-1].lower()
    assert repository_id.startswith("home-") and REPOSITORY_ID_RE.fullmatch(repository_id)
    assert account not in repository_id


@pytest.mark.parametrize(
    "canonical, windows, slug",
    [("C:\\Users\\you\\project", True, "project"), ("/home/you/project", False, "project"), ("/srv/example", False, "example")],
)
def test_folders_below_or_beside_a_profile_keep_their_own_slug(canonical, windows, slug):
    assert repository_id_for(canonical, windows=windows).startswith(f"{slug}-")


def test_an_unnameable_basename_gets_the_repository_slug():
    assert repository_id_for("/work/\U0001f600", windows=False).startswith("repository-")
    assert repository_id_for("/", windows=False).startswith("repository-")


@pytest.mark.parametrize("basename", ["CON", "nul.txt", "aux.x", "com1.y", "lpt9.a"])
def test_device_like_slugs_are_ordinary_folders_on_this_system(basename, tmp_path):
    """The ID of a repository named like a Windows device is a folder this system can create and use."""
    repository_id = repository_id_for(str(tmp_path / basename))
    storage._ensure_root(data_root())
    folder = storage._directory(data_root(), ("repositories", repository_id), create=True)
    (folder / "probe.txt").write_text("x", encoding="utf-8")
    assert (folder / "probe.txt").read_text(encoding="utf-8") == "x"
    assert repository_id in os.listdir(folder.parent)


# --- canonicalization of real folders ---------------------------------------------------------


def test_spelling_variants_of_one_folder_share_one_id(tmp_path, monkeypatch):
    repo = _repo(tmp_path, "Repo-Root")
    (repo / "sub").mkdir()
    expected = repository_identity(repo)
    spellings = [
        str(repo),
        str(repo) + os.sep,
        str(repo / "sub" / ".."),
        str(repo / "."),
        repo.as_posix(),
    ]
    monkeypatch.chdir(repo.parent)
    spellings.append("Repo-Root")
    for spelling in spellings:
        _forget()
        assert repository_identity(spelling) == expected, spelling
    assert expected.root == Path(os.path.realpath(repo))
    assert REPOSITORY_ID_RE.fullmatch(expected.repository_id)
    assert expected.repository_id.startswith("repo-root-")


@pytest.mark.skipif(not WINDOWS, reason="Windows: letter case and drive-letter case fold to one ID")
def test_windows_letter_case_variants_share_one_id(tmp_path):
    repo = _repo(tmp_path, "Repo-Root")
    expected = repository_identity(repo)
    text = str(repo)
    for spelling in (text.upper(), text.lower(), text[0].lower() + text[1:], text.replace("\\", "/")):
        _forget()
        assert repository_identity(spelling) == expected, spelling


def test_a_root_reached_through_a_symbolic_link_has_the_targets_id(tmp_path):
    target = _repo(tmp_path, "target-repo")
    link = tmp_path / "linked-repo"
    _symlink_dir(link, target)
    assert repository_identity(link) == repository_identity(target)


@pytest.mark.skipif(not WINDOWS, reason="junctions are Windows' (_winapi.CreateJunction)")
def test_a_root_reached_through_a_junction_has_the_targets_id(tmp_path):
    target = _repo(tmp_path, "target-repo")
    link = tmp_path / "junctioned-repo"
    _junction(link, target)
    assert repository_identity(link) == repository_identity(target)


def test_a_missing_folder_or_a_file_is_refused_before_anything_is_written(tmp_path):
    before = _snapshot(data_root())
    with pytest.raises(StorageError, match="does not exist") as missing:
        repository_identity(tmp_path / "missing")
    (tmp_path / "file.txt").write_text("x", encoding="utf-8")
    with pytest.raises(StorageError, match="not a folder"):
        repository_identity(tmp_path / "file.txt")
    with pytest.raises(StorageError, match="not valid"):
        repository_identity(os.fsencode(str(tmp_path)))  # type: ignore[arg-type]
    assert str(tmp_path) not in str(missing.value)
    assert _snapshot(data_root()) == before


def test_the_identity_is_memoized_per_process():
    repo = Path(os.getcwd())
    assert repository_identity(repo) is repository_identity(repo)


# --- distinct repositories -------------------------------------------------------------------


def test_two_repositories_with_the_same_basename_get_different_ids_and_the_same_slug(tmp_path):
    first = repository_identity(_repo(tmp_path, "one", "app"))
    second = repository_identity(_repo(tmp_path, "two", "app"))
    assert first.repository_id != second.repository_id
    assert first.repository_id[:-17] == second.repository_id[:-17] == "app"


def test_a_nested_repository_has_its_own_namespace(tmp_path):
    outer = _repo(tmp_path, "outer")
    inner = _repo(outer, "vendor", "inner")
    assert repository_identity(outer).repository_id != repository_identity(inner).repository_id


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git for a real worktree")
def test_each_git_worktree_has_its_own_namespace(tmp_path):
    main = _repo(tmp_path, "checkout")
    git = ["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false"]
    (main / "README.md").write_text("x\n", encoding="utf-8")
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "initial"], ["worktree", "add", "-q", str(tmp_path / "checkout-wt")]):
        subprocess.run([*git, *args], cwd=main, check=True, capture_output=True)
    worktree = tmp_path / "checkout-wt"
    assert (worktree / ".git").is_file()  # a worktree's .git is a file: no git discovery is involved
    assert repository_identity(main).repository_id != repository_identity(worktree).repository_id


def test_a_renamed_repository_gets_a_new_namespace_and_the_old_one_is_untouched(tmp_path):
    before_rename = _repo(tmp_path, "project")
    old = repository_storage(before_rename)
    old.ensure()
    old.work_item_dir("JR-12345", create=True)
    snapshot = _snapshot(old._directory)
    renamed = tmp_path / "project-renamed"
    before_rename.rename(renamed)
    _forget()
    new = repository_storage(renamed)
    assert new.identity.repository_id != old.identity.repository_id
    assert new.record_state() == "absent"
    assert _snapshot(old._directory) == snapshot


# --- platform-only cases (§7.3) ----------------------------------------------------------------


def _case_sensitive(folder: Path) -> bool:
    probe = folder / "CaseProbe"
    probe.mkdir()
    try:
        return not (folder / "caseprobe").exists()
    finally:
        probe.rmdir()


def test_posix_case_distinct_folders_are_distinct_repositories(tmp_path):
    if WINDOWS:
        pytest.skip("Windows folds letter case into one repository (normcase)")
    if not _case_sensitive(tmp_path):
        pytest.skip("this volume is case-insensitive (the macOS default): two such folders cannot coexist")
    upper = repository_identity(_repo(tmp_path, "Repo"))
    lower = repository_identity(_repo(tmp_path, "repo"))
    assert upper.repository_id != lower.repository_id


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS: getcwd() and /private/var")
def test_macos_working_directory_gives_the_stored_case_and_private_var_resolves(tmp_path, monkeypatch):
    repo = _repo(tmp_path, "Repo-Root")
    expected = repository_identity(repo)
    if not _case_sensitive(tmp_path):
        monkeypatch.chdir(tmp_path / "repo-root")  # a case variant of the stored name
        _forget()
        assert repository_identity(Path.cwd()) == expected
    text = str(repo)
    if text.startswith("/private/var/"):
        _forget()
        assert repository_identity(text[len("/private"):]) == expected


def test_nfc_and_nfd_spellings_never_merge_two_folders(tmp_path):
    """§7.3: no Unicode normalization on purpose. Where both spellings are two folders they stay two namespaces."""
    import unicodedata

    nfc, nfd = unicodedata.normalize("NFC", "Café"), unicodedata.normalize("NFD", "Café")
    first = _repo(tmp_path, nfc)
    try:
        second = _repo(tmp_path, nfd)
    except FileExistsError:
        # A normalization-insensitive volume (macOS): the second spelling is the same folder, never another one.
        _forget()
        assert repository_identity(tmp_path / nfd).root.samefile(repository_identity(first).root)
        return
    assert repository_identity(first).repository_id != repository_identity(second).repository_id


@pytest.mark.skip(
    reason="subst drive: NOT VERIFIED. Creating a drive letter is a session-wide change outside a test's folder; "
    "deferred pending separate owner approval (plan D0A-5, §7.3)"
)
def test_a_subst_drive_has_the_underlying_folders_id():  # pragma: no cover - documented, not run
    raise AssertionError("not run")


# --- the identity record (§7.5) ----------------------------------------------------------------


def test_ensure_writes_a_deterministic_record_and_the_namespace(tmp_path):
    repo = _repo(tmp_path, "checkout")
    namespace = repository_storage(repo)
    assert namespace.record_state() == "absent"
    namespace.ensure()
    assert namespace.record_state() == "ok"
    expected = (
        "{\n"
        '  "schema_version": 1,\n'
        f'  "repository_id": "{namespace.identity.repository_id}",\n'
        f"  \"root\": {json.dumps(str(namespace.identity.root))}\n"
        "}\n"
    )
    assert namespace._record_file.read_bytes() == expected.encode("ascii")
    assert namespace._directory == data_root() / "repositories" / namespace.identity.repository_id
    first = namespace._record_file.read_bytes()
    namespace.ensure()  # idempotent: nothing rewritten
    assert namespace._record_file.read_bytes() == first
    assert sorted(os.listdir(namespace._directory)) == ["repository.json"]


def test_a_namespace_without_its_record_gets_one_on_the_write_path_and_reads_proceed(tmp_path):
    repo = _repo(tmp_path, "checkout")
    namespace = repository_storage(repo)
    namespace._directory.mkdir(parents=True)  # an interrupted ensure()
    assert namespace.record_state() == "missing-record"
    assert namespace.work_item_dir("JR-12345", create=False) == (namespace._directory / "work") / "JR-12345"
    assert not namespace._record_file.exists()
    namespace.ensure()
    assert namespace.record_state() == "ok"


def _write_record(namespace, content: bytes) -> None:
    namespace._directory.mkdir(parents=True, exist_ok=True)
    namespace._record_file.write_bytes(content)


def _record(namespace, **changes) -> bytes:
    record = {"schema_version": 1, "repository_id": namespace.identity.repository_id, "root": str(namespace.identity.root)}
    record.update(changes)
    return (json.dumps(record, indent=2) + "\n").encode()


CORRUPT_RECORDS = {
    "not JSON": lambda ns: b"{not json",
    "empty": lambda ns: b"",
    "not UTF-8": lambda ns: b"\xff\xfe\x00",
    "not an object": lambda ns: b"[1, 2, 3]\n",
    "schema_version 2": lambda ns: _record(ns, schema_version=2),
    "schema_version as text": lambda ns: _record(ns, schema_version="1"),
    "schema_version as true": lambda ns: _record(ns, schema_version=True),
    "another repository id": lambda ns: _record(ns, repository_id="other-0123456789abcdef"),
    "root not text": lambda ns: _record(ns, root=7),
    "an extra key": lambda ns: _record(ns, note="x"),
    "a missing key": lambda ns: json.dumps({"schema_version": 1, "repository_id": ns.identity.repository_id}).encode(),
    "too large": lambda ns: _record(ns) + b" " * (70 * 1024),
}


def _all_access(namespace) -> dict[str, object]:
    return {
        "ensure": namespace.ensure,
        "work_item_dir(read)": lambda: namespace.work_item_dir("JR-12345", create=False),
        "work_item_dir(write)": lambda: namespace.work_item_dir("JR-12345", create=True),
        "memory_file(read)": lambda: namespace.memory_file("JR-12345", create=False),
        "settings_file(read)": lambda: namespace.settings_file("verification.md", create=False),
        "settings_file(write)": lambda: namespace.settings_file("verification.md", create=True),
        "fix_modes_dir(read)": lambda: namespace.fix_modes_dir(create=False),
        "work_items": namespace.work_items,
    }


@pytest.mark.parametrize("name", sorted(CORRUPT_RECORDS))
def test_a_corrupt_record_is_refused_for_reads_and_writes_and_never_repaired(tmp_path, name):
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    content = CORRUPT_RECORDS[name](namespace)
    _write_record(namespace, content)
    assert namespace.record_state() == "corrupt"
    before = _snapshot(data_root())
    for label, access in _all_access(namespace).items():
        with pytest.raises(StorageIdentityError, match="not a readable repository record") as refused:
            access()
        assert str(data_root()) not in str(refused.value), label
    assert namespace._record_file.read_bytes() == content
    assert _snapshot(data_root()) == before


def test_a_record_naming_another_repository_is_refused_for_reads_and_writes(tmp_path):
    """The collision case: a namespace whose record holds another root is never read or written (§7.5)."""
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    content = _record(namespace, root=str(tmp_path / "somewhere-else"))
    _write_record(namespace, content)
    assert namespace.record_state() == "mismatch"
    before = _snapshot(data_root())
    for label, access in _all_access(namespace).items():
        with pytest.raises(StorageIdentityError, match="belongs to a different repository folder") as refused:
            access()
        message = str(refused.value)
        assert str(tmp_path) not in message and str(data_root()) not in message, label
        assert "~/.bugpilot/" in message or "BUGPILOT_HOME/" in message
    assert namespace._record_file.read_bytes() == content
    assert _snapshot(data_root()) == before


def _case_variant(root: str) -> str:
    return root[:-1] + root[-1].swapcase()


@pytest.mark.skipif(not WINDOWS, reason="Windows: a case-only rename keeps the folded key, so the same ID")
def test_a_case_only_rename_keeps_the_namespace_and_never_rewrites_the_record(tmp_path):
    """Review finding M2: the same folder after a case-only rename is accepted by its file identity."""
    parent = _repo(tmp_path, "Source")
    repo = _repo(parent, "repo")
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-12345", create=True)
    record_before = namespace._record_file.read_bytes()
    parent.rename(tmp_path / "source")  # a case-only rename of a folder above the repository
    _forget()
    renamed = repository_storage(tmp_path / "source" / "repo")
    assert str(renamed.identity.root) != str(namespace.identity.root)  # the stored spelling changed
    assert renamed.identity.repository_id == namespace.identity.repository_id  # the folded key did not
    assert renamed.record_state() == "ok"
    assert renamed.work_item_dir("JR-12345", create=False).is_dir()
    assert renamed._record_file.read_bytes() == record_before  # never rewritten


def test_a_genuine_folded_key_collision_is_refused(tmp_path, monkeypatch):
    """Two different folders whose folded keys collide (case-sensitive Windows folders) never share a namespace.

    No such pair can be created on a case-insensitive volume, so the second
    folder is simulated: the recorded spelling resolves to another file
    identity. On POSIX no key is folded, so a case variant is another
    repository outright.
    """
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    _write_record(namespace, _record(namespace, root=_case_variant(str(namespace.identity.root))))
    if WINDOWS:
        assert namespace.record_state() == "ok"  # the same folder, spelled differently: proven, then accepted
        _forget()
        monkeypatch.setattr(storage, "_same_folder", lambda first, second: False)
    assert namespace.record_state() == "mismatch"
    with pytest.raises(StorageIdentityError, match="belongs to a different repository folder"):
        namespace.work_item_dir("JR-12345", create=False)


@pytest.mark.skipif(not WINDOWS, reason="Windows: only there is a recorded spelling compared by file identity")
def test_a_recorded_spelling_that_no_longer_resolves_is_refused(tmp_path, monkeypatch):
    """If the recorded root cannot be examined, the same folder cannot be proven: fail closed."""
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    variant = _case_variant(str(namespace.identity.root))
    _write_record(namespace, _record(namespace, root=variant))
    real_stat = os.stat

    def unresolvable(path, *args, **kwargs):
        if os.fspath(path) == variant:
            raise FileNotFoundError(2, "gone")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(storage.os, "stat", unresolvable)
    assert namespace.record_state() == "mismatch"


def test_a_link_at_the_record_or_a_folder_in_its_place_is_refused(tmp_path):
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    namespace._directory.mkdir(parents=True)
    namespace._record_file.mkdir()
    assert namespace.record_state() == "corrupt"
    with pytest.raises(StorageIdentityError):
        namespace.ensure()
    namespace._record_file.rmdir()
    elsewhere = tmp_path / "a-valid-record.json"
    elsewhere.write_bytes(_record(namespace))
    try:
        os.symlink(elsewhere, namespace._record_file)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"file symbolic links are not available here: {type(error).__name__}")
    assert namespace.record_state() == "corrupt"
    with pytest.raises(StorageIdentityError):
        namespace.work_item_dir("JR-12345", create=False)
    assert os.path.islink(namespace._record_file)


def test_a_record_rewritten_after_it_was_verified_is_verified_again(tmp_path):
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    namespace.ensure()
    assert namespace.record_state() == "ok"
    namespace._record_file.write_bytes(_record(namespace, root=str(tmp_path / "other")) + b" ")
    assert namespace.record_state() == "mismatch"


# --- fresh caches (Batch 2A) -------------------------------------------------------------------


def _count_reads(monkeypatch) -> dict[str, int]:
    reads = {"record": 0}
    real = storage._read_regular

    def counting(path, info):
        reads["record"] += 1
        return real(path, info)

    monkeypatch.setattr(storage, "_read_regular", counting)
    return reads


def test_a_verified_record_is_read_once_per_request_scope_and_every_time_outside_one(tmp_path, monkeypatch):
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    namespace.ensure()
    reads = _count_reads(monkeypatch)
    namespace.record_state()
    namespace.record_state()
    assert reads["record"] == 2  # outside a scope nothing is remembered
    with storage.request_scope():
        namespace.record_state()
        namespace.work_item_dir("JR-12345", create=False)
        namespace.record_state()
    assert reads["record"] == 3
    with storage.request_scope():
        namespace.record_state()
    assert reads["record"] == 4


@pytest.mark.parametrize("kind", ["symlink"] + (["junction"] if WINDOWS else []))
def test_a_retargeted_link_never_reuses_a_cached_identity(tmp_path, kind):
    first, second = _repo(tmp_path, "first"), _repo(tmp_path, "second")
    link = tmp_path / "bound"
    plant = _symlink_dir if kind == "symlink" else _junction
    plant(link, first)
    assert repository_identity(link) == repository_identity(first)
    try:
        os.unlink(link)
    except OSError:
        os.rmdir(link)
    plant(link, second)
    assert repository_identity(link) == repository_identity(second)


def test_a_folder_replaced_at_the_same_path_keeps_its_path_based_id(tmp_path):
    folder = _repo(tmp_path, "checkout")
    before = repository_identity(folder)
    shutil.rmtree(folder)
    folder.mkdir()
    assert repository_identity(folder) == before  # §7.2: the ID is the path's, re-resolved, never another's


def test_a_cached_identity_of_a_folder_that_is_gone_is_refused_and_forgotten(tmp_path):
    folder = _repo(tmp_path, "checkout")
    repository_identity(folder)
    shutil.rmtree(folder)
    with pytest.raises(StorageError, match="does not exist"):
        repository_identity(folder)
    assert os.path.abspath(folder) not in storage._identities


def test_an_identity_without_a_stable_file_index_is_resolved_every_time_and_never_cached(tmp_path, monkeypatch):
    folder = _repo(tmp_path, "checkout")
    real_stat = os.stat
    canonical = os.path.realpath(folder)

    def no_index(path, *args, **kwargs):
        info = real_stat(path, *args, **kwargs)
        if os.path.realpath(path) == canonical:
            return os.stat_result((info.st_mode, 0, *tuple(info)[2:]))  # a file system without file indexes
        return info

    monkeypatch.setattr(storage.os, "stat", no_index)
    calls = {"resolved": 0}
    real_identity = storage._identity

    def resolving(absolute):
        calls["resolved"] += 1
        return real_identity(absolute)

    monkeypatch.setattr(storage, "_identity", resolving)
    first, second = repository_identity(folder), repository_identity(folder)
    assert first == second and calls["resolved"] == 2
    assert os.path.abspath(folder) not in storage._identities


def test_the_identity_cache_is_bounded(tmp_path):
    for index in range(storage._IDENTITY_CACHE_LIMIT + 5):
        repository_identity(_repo(tmp_path, f"r{index:03d}"))
    assert len(storage._identities) == storage._IDENTITY_CACHE_LIMIT


# --- two processes, one namespace (§8.7) -------------------------------------------------------

_RACER = textwrap.dedent(
    """
    import os, sys, time
    from pathlib import Path
    from bugpilot.core.storage import repository_storage
    roots = [Path(p) for p in sys.argv[2:]]
    go = Path(sys.argv[1])
    deadline = time.monotonic() + 60
    while not go.exists():
        if time.monotonic() > deadline:
            raise SystemExit("no start signal")
        time.sleep(0.001)
    for root in roots:
        namespace = repository_storage(root)
        namespace.ensure()
        namespace.work_item_dir("JR-12345", create=True)
        assert namespace.record_state() == "ok"
    print("done", len(roots))
    """
)


def test_two_processes_ensuring_the_same_namespaces_end_with_identical_records_and_no_error(tmp_path):
    roots = [_repo(tmp_path, "repos", f"repo-{index:02d}") for index in range(50)]
    go = tmp_path / "go"
    env = dict(os.environ, PYTHONPATH=_isolation.child_pythonpath(REPO))
    racers = [
        subprocess.Popen(
            [sys.executable, "-c", _RACER, str(go), *map(str, roots)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        for _ in range(2)
    ]
    time.sleep(0.5)
    go.write_text("go", encoding="utf-8")
    results = [racer.communicate(timeout=300) for racer in racers]
    for racer, (out, err) in zip(racers, results):
        assert racer.returncode == 0, err
        assert out.strip() == "done 50"
    for root in roots:
        namespace = repository_storage(root)
        assert namespace.record_state() == "ok"
        assert namespace._record_file.read_bytes() == storage._record_text(namespace.identity).encode("ascii")
        leftovers = [name for name in os.listdir(namespace._directory) if name not in ("repository.json", "work")]
        assert leftovers == [], leftovers  # no temporary record left behind


_READER = textwrap.dedent(
    """
    import sys, time
    from pathlib import Path
    from bugpilot.core.storage import StorageError, StorageIdentityError, repository_storage
    roots = [Path(p) for p in sys.argv[2:]]
    go = Path(sys.argv[1])
    deadline = time.monotonic() + 60
    while not go.exists():
        if time.monotonic() > deadline:
            raise SystemExit("no start signal")
        time.sleep(0.001)
    seen, busy, pending = set(), 0, set(roots)
    while pending and time.monotonic() < deadline + 120:
        for root in list(pending):
            try:
                state = repository_storage(root).record_state()
            except StorageIdentityError as error:
                raise SystemExit(f"refused as another repository's or unreadable: {error}")
            except StorageError as error:
                if "right now" not in str(error):
                    raise
                busy += 1  # an honest "in use", never a verdict on the record
                continue
            seen.add(state)
            if state not in ("absent", "missing-record", "ok"):
                raise SystemExit(f"a reader saw {state!r} during publication")
            if state == "ok":
                pending.discard(root)
    print("read", len(roots) - len(pending), sorted(seen), busy)
    """
)


def test_a_reader_during_publication_never_sees_a_partial_or_foreign_record(tmp_path):
    """Review finding M3: concurrent readers see no record or the whole record, never "corrupt"."""
    roots = [_repo(tmp_path, "repos", f"repo-{index:02d}") for index in range(50)]
    go = tmp_path / "go"
    env = dict(os.environ, PYTHONPATH=_isolation.child_pythonpath(REPO))
    children = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(go), *map(str, roots)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        for script in (_READER, _RACER, _RACER)
    ]
    time.sleep(0.5)
    go.write_text("go", encoding="utf-8")
    results = [child.communicate(timeout=300) for child in children]
    for child, (out, err) in zip(children, results):
        assert child.returncode == 0, err
    reader_out = results[0][0].split()
    assert reader_out[:2] == ["read", "50"], results[0]


# --- resolution creates nothing (T-S14) --------------------------------------------------------


def _read_only_calls(repo: Path) -> None:
    namespace = repository_storage(repo)
    namespace.record_state()
    namespace.work_item_dir("JR-12345", create=False)
    namespace.attachments_dir("JR-12345", create=False)
    namespace.memory_file("JR-12345", create=False)
    for name in sorted(storage.SETTINGS_NAMES):
        namespace.settings_file(name, create=False)  # type: ignore[arg-type]
    namespace.fix_modes_dir(create=False)
    namespace.work_items()
    namespace.diagnostics()
    shared = global_storage()
    shared.config_file(create=False)
    shared.user_instructions_file(create=False)
    shared.user_fix_modes_dir(create=False)
    shared.diagnostics()
    display_path((namespace._directory / "work"))
    data_root()
    data_root_source()


def test_resolution_creates_nothing_when_the_data_root_does_not_exist(tmp_path):
    repo = _repo(tmp_path, "checkout")
    assert not os.path.lexists(data_root())
    _read_only_calls(repo)
    assert not os.path.lexists(data_root())


def test_resolution_creates_nothing_in_an_existing_namespace(tmp_path):
    repo = _repo(tmp_path, "checkout")
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-12345", create=True)
    before = _snapshot(data_root())
    repo_before = _snapshot(repo)
    _read_only_calls(repo)
    assert _snapshot(data_root()) == before
    assert _snapshot(repo) == repo_before


# --- isolation between repositories (T-S7) -----------------------------------------------------


def test_two_repositories_with_the_same_work_item_keep_apart(tmp_path):
    first = repository_storage(_repo(tmp_path, "a", "app"))
    second = repository_storage(_repo(tmp_path, "b", "app"))
    one = first.work_item_dir("JR-12345", create=True)
    two = second.work_item_dir("JR-12345", create=True)
    assert one != two
    (one / "task.md").write_text("first", encoding="utf-8")
    (two / "task.md").write_text("second", encoding="utf-8")
    assert (first.work_item_dir("JR-12345", create=False) / "task.md").read_text(encoding="utf-8") == "first"
    assert (second.work_item_dir("JR-12345", create=False) / "task.md").read_text(encoding="utf-8") == "second"
    assert [item.work_item_id for item in first.work_items()] == ["JR-12345"]


def test_no_api_takes_a_repository_id_as_input():
    """Cross-repository access needs an ID as input; the public API never accepts one (§8.3)."""
    import inspect

    for name in storage.__all__:
        member = getattr(storage, name)
        if callable(member) and not isinstance(member, type):
            assert "repository_id" not in inspect.signature(member).parameters, name
    for method in ("work_item_dir", "attachments_dir", "memory_file", "settings_file", "fix_modes_dir", "work_items", "ensure"):
        assert "repository_id" not in inspect.signature(getattr(storage.RepositoryStorage, method)).parameters


def test_display_paths_never_name_the_users_folder(tmp_path, monkeypatch):
    namespace = repository_storage(_repo(tmp_path, "checkout"))
    task = (namespace._directory / "work") / "JR-12345" / "task.md"
    shown = display_path(task)
    assert shown == f"BUGPILOT_HOME/repositories/{namespace.identity.repository_id}/work/JR-12345/task.md"
    monkeypatch.delenv("BUGPILOT_HOME")
    default = repository_storage(tmp_path / "checkout")
    shown = display_path((default._directory / "work") / "JR-12345" / "task.md")
    assert shown.startswith("~/.bugpilot/repositories/") and str(Path.home()) not in shown
    assert display_path(data_root()) == "~/.bugpilot"
    with pytest.raises(ValueError):
        display_path(tmp_path / "outside.txt")


# --- the frozen JSON contract (§8.10, Batch 1 step 9) -----------------------------------------


def _plan_section() -> str:
    text = PLAN.read_text(encoding="utf-8")
    start = text.index("### 8.10 The storage JSON contract")
    return text[start : text.index("\n---\n", start)]


def _table_after(section: str, marker: str) -> list[list[str]]:
    lines = section[section.index(marker) :].split("\n")
    rows: list[list[str]] = []
    header = False
    for line in lines[1:]:
        if line.startswith("|"):
            cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
            if not header:
                header = True
            elif not set("".join(cells)) <= set("-: "):
                rows.append(cells)
        elif header and rows:
            break
    return rows


def test_the_contract_fixture_is_well_formed():
    fixture = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert set(fixture) == {"_comment", "status", "id_pattern", "kinds", "keys", "entries", "unchanged", "open_choices"}
    assert fixture["id_pattern"] == REPOSITORY_ID_RE.pattern
    assert [kind["kind"] for kind in fixture["kinds"]] == ["abs", "ns", "display", "posix-abs", "id"]
    for entry in fixture["keys"]:
        assert set(entry) == {"surface", "key", "kind", "null_when", "change"}
        assert all(isinstance(value, str) and value for value in entry.values()), entry
    assert fixture["unchanged"]["storage_errors_report"] == "INVALID_INPUT"
    # Approved in part at the Batch 1 gate (2026-10-16): every decision a row still depends on is carved out by name.
    assert fixture["status"].startswith("APPROVED IN PART (US-D26, by the owner, 2026-10-16)")
    depended_on = {decision for entry in fixture["entries"] for decision in entry["decisions"]}
    assert depended_on == {"US-D3", "US-D4", "US-D16", "US-D18", "US-D25"}
    assert all(re.search(rf"\b{decision}\b", fixture["status"]) for decision in depended_on)
    assert any("STORAGE_UNAVAILABLE" in choice for choice in fixture["open_choices"])


def test_the_contract_fixture_matches_section_8_10_exactly():
    fixture = json.loads(CONTRACT.read_text(encoding="utf-8"))
    section = _plan_section()
    kinds = [{"kind": k.strip("`"), "definition": d, "example": e} for k, d, e in _table_after(section, "**Value kinds**")]
    keys, surface = [], ""
    for first, key, kind, null_when, change in _table_after(section, "**Keys.**"):
        surface = first or surface
        keys.append({"surface": surface, "key": key, "kind": kind, "null_when": null_when, "change": change})
    assert fixture["kinds"] == kinds
    assert fixture["keys"] == keys
    assert len(keys) == 46


ENTRY_FIELDS = {
    "row", "surface_kind", "commands", "commands_complete", "output", "event", "flags", "direction",
    "parent", "each", "keys", "schema_ref", "kind", "format", "values", "adds", "paths",
    "change", "was", "conditional_on", "decisions", "refs", "unchanged_fields", "nullable", "null_when",
}
PATH_KINDS = ("abs", "ns", "display", "posix-abs", "id")
# How each non-path kind is written in the prose's kind column (review finding L6).
KIND_PROSE = {
    "timestamp": "`YYYY-MM-DDTHH:MM:SSZ`",
    "enum": "`\"",
    "boolean": "boolean",
    "object": "an object",
    "sentence": "one sentence",
    "text": "text naming",
    "string-list": "gains",
    "input-file": "a regular UTF-8 file",
}


def _ticked(cell: str) -> list[str]:
    return re.findall(r"`([^`]+)`", cell)


def test_the_contract_entries_restate_each_prose_row_and_nothing_else():
    """Review finding L6: ``entries`` is the machine-readable form of ``keys``; every field is tied to its prose."""
    fixture = json.loads(CONTRACT.read_text(encoding="utf-8"))
    entries, prose_rows = fixture["entries"], fixture["keys"]
    assert len(entries) == len(prose_rows) == 46
    previous_null_when = None
    for row, (entry, prose) in enumerate(zip(entries, prose_rows), start=1):
        surface, key_cell, kind_cell, change = prose["surface"], prose["key"], prose["kind"], prose["change"]
        assert set(entry) == ENTRY_FIELDS and entry["row"] == row, row
        # where: the surface, its commands, form, event, flags
        expected_kind = "mcp" if surface.startswith("MCP") else "persisted" if surface.startswith("persisted") else "cli"
        assert entry["surface_kind"] == expected_kind, row
        assert entry["commands"] and all(word in surface for command in entry["commands"] for word in command.split()), row
        assert entry["commands_complete"] == ("…" not in surface), row
        expected_output = {"mcp": "mcp", "persisted": "file"}.get(expected_kind) or (
            "json-lines" if "--json-lines" in surface else "json"
        )
        assert entry["output"] == expected_output and (expected_output != "json" or "--json" in surface), row
        assert (entry["event"] is None) == ("event" not in surface), row
        assert entry["event"] is None or f"event `{entry['event']}`" in surface, row
        assert all(flag in surface for flag in entry["flags"]) and ("--retry" in surface) == bool(entry["flags"]), row
        assert entry["direction"] == ("input" if key_cell.startswith("input") else "output"), row
        assert (entry["parent"] is not None) == ("→" in surface), row
        assert entry["parent"] is None or surface.endswith(f"→ `{entry['parent']}`"), row
        # which keys
        assert entry["each"] is None or f"each {entry['each']}'s" in key_cell, row
        if entry["schema_ref"] is not None:
            assert entry["keys"] == [] and key_cell == entry["schema_ref"], row
        else:
            ticked = _ticked(key_cell)
            assert len(ticked) == len(entry["keys"]), row
            assert all(tick == key or tick.startswith(key + " ") for tick, key in zip(ticked, entry["keys"])), row
        # what kind of value
        if entry["kind"] is None:
            assert kind_cell == "—", row
        elif entry["kind"] in PATH_KINDS:
            assert kind_cell.startswith(f"`{entry['kind']}`"), row
        else:
            assert KIND_PROSE[entry["kind"]] in kind_cell, row
        assert entry["format"] is None or f"`{entry['format']}`" in kind_cell, row
        assert (entry["kind"] == "enum") == (entry["values"] is not None), row
        for value in (entry["values"] or []) + (entry["adds"] or []):
            assert f'"{value}"' in kind_cell, row
        assert entry["paths"] is None or entry["paths"] in kind_cell, row
        # when it is null
        assert entry["nullable"] == (prose["null_when"] not in ("never", "—")), row
        resolved = previous_null_when if prose["null_when"] == "as above" else prose["null_when"]
        assert entry["null_when"] == (resolved if entry["nullable"] else None), row
        previous_null_when = resolved
        # how it changes, and on whose decision
        expected_change = "new" if change.startswith("**new**") else "removed" if change.startswith("**removed**") else "value"
        assert entry["change"] == expected_change and (expected_change != "value" or change.startswith("value")), row
        assert entry["was"] is None or f"was `{entry['was']}`" in change or f"was {entry['was']}" in change, row
        assert ("(was" in change) == (entry["was"] is not None), row
        assert entry["decisions"] == re.findall(r"US-D\d+", change), row
        assert entry["refs"] == re.findall(r"\bSF-\d+", change), row
        assert (entry["conditional_on"] is not None) == ("only if" in change), row
        assert entry["conditional_on"] is None or f"only if {entry['conditional_on']}" in change, row
        for field, value in (entry["unchanged_fields"] or {}).items():
            assert f"`{field}` stays {value}" in change, row
        assert ("stays" in change) == (entry["unchanged_fields"] is not None), row
