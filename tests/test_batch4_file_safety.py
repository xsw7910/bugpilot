"""The credentials file, the atomic writer's failure paths and F13 (0.1.5 Batch 4, plan §44.2.B, §44.6 S2–S3).

What Batch 4 promises, checked on the real file system — modes read with
`lstat`, link targets compared byte for byte, temp files looked for by name —
never by asking the product's own helpers what they did:

- **S2, B5 — the credentials file is owner-only from its first moment.** Every
  state of it the file system shows — the temp file as created, as renamed, the
  file in place — is `0600` or narrower, under five umasks; a rewrite is `0600`
  whatever the old bits; a concurrent observer never sees it otherwise, nor
  half of it. Its location and format are as before.
- **O4 — a link at its path is refused,** for both writers: to a file, to a
  folder, dangling, and swapped in while writes run. The target and the link
  are left byte for byte as they were. The folder holding the file is the
  user's to place, as a repository root is (decision B4-2, §44.22).
- **The atomic writer's failure paths,** for every caller: a write or a rename
  that fails leaves the target as it was and no temp file; a private write
  never falls back to an in-place write on POSIX.
- **F13 — `task-preview <id>` reads nothing through a link** at `.ai`, the work
  item's folder or `issue.json`, as `context-preview` already refuses.

The permission checks are POSIX's and skip on Windows, where `chmod` sets only
the read-only flag; the link checks use a junction where a symbolic link to a
file needs a privilege, and skip where neither can be made. A sequential test
cannot prove race freedom: the concurrent tests here show what the design
guarantees by construction (a rename never follows the name it replaces), not
every interleaving.
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import user_config
from bugpilot.core.artifact_io import atomic_write_text
from bugpilot.core.context_preview import STATE_UNREADABLE, preview_context
from bugpilot.core.safe_paths import UnsafePathError
from bugpilot.core.task_preview import TaskPreviewError, preview_work_item

POSIX = os.name == "posix"
posix_only = pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's; on Windows chmod sets only the read-only flag")
needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="preparing a work item searches the code with ripgrep")

EMAIL, TOKEN, SITE = "dev@example.invalid", "synthetic-token-JR-12345", "https://jira.example.invalid"
#: The file's format, written out by hand: 0.1.4's, unchanged.
EXPECTED_TOML = f'jira_email = "{EMAIL}"\njira_base_url = "{SITE}"\njira_token = "{TOKEN}"\n'


@pytest.fixture
def umask():
    previous = os.umask(0o022)
    os.umask(previous)
    yield os.umask
    os.umask(previous)


def _mode(path: Path) -> int:
    return stat.S_IMODE(os.lstat(path).st_mode)


def _temp_files(folder: Path) -> list[str]:
    """What the atomic writer would leave behind: its `.<name>.<random>.tmp` files."""
    return sorted(name for name in os.listdir(folder) if name.startswith(".") and name.endswith(".tmp"))


def _link_target(link: Path) -> str:
    """Where a link points, as written; Windows reports it with the extended-length prefix."""
    target = os.readlink(link)
    prefix = "\\\\?\\"
    return target[len(prefix):] if target.startswith(prefix) else target


def _link_file(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symbolic links to files need a privilege this account does not have")


def _link_dir(link: Path, target: Path) -> str:
    try:
        link.symlink_to(target, target_is_directory=True)
        return "symlink"
    except OSError:
        if os.name != "nt":
            raise
    import _winapi  # Windows only: a junction needs no privilege

    _winapi.CreateJunction(str(target), str(link))
    return "junction"


def _save(writer: str) -> Path:
    if writer == "save_user_config":
        return user_config.save_user_config(EMAIL, TOKEN, SITE)
    return user_config.save_jira_site(SITE)


# --- S2, B5: owner-only from the first moment -----------------------------------------------------


def test_the_credentials_file_holds_what_it_held_before():
    """Format unchanged (§44.7): the same flat table, the same order, read back the same. The place is
    `config/config.toml` in BugPilot's data folder since 0.1.6 Batch 2B-2."""
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert path == Path(os.environ["BUGPILOT_HOME"]) / "config" / "config.toml"
    assert path.read_bytes().decode("utf-8").replace("\r\n", "\n") == EXPECTED_TOML
    user_config.save_jira_site("https://other.example.invalid")
    loaded = user_config.load_user_config()
    assert (loaded.jira_email, loaded.jira_token, loaded.jira_base_url) == (EMAIL, TOKEN, "https://other.example.invalid")
    assert _temp_files(path.parent) == []


@posix_only
@pytest.mark.parametrize("mask", [0o022, 0o002, 0o000, 0o077, 0o277])
def test_every_state_of_a_new_credentials_file_is_owner_only(umask, monkeypatch, mask, user_config_folder):
    """The temp file as created, as renamed, and the file in place, each read with `lstat` as it happens: never
    readable by anyone but its owner (a umask that takes the owner's write bit makes the first state `0400`,
    narrower still); `0600` in place."""
    assert user_config_folder.is_dir()  # made private, as BugPilot makes it, before a mask that takes write
    umask(mask)
    seen: list[tuple[str, int]] = []
    real_mkstemp, real_replace = tempfile.mkstemp, os.replace

    def mkstemp(*args, **kwargs):
        handle, name = real_mkstemp(*args, **kwargs)
        seen.append(("created", _mode(Path(name))))
        return handle, name

    def replace(source, target):
        seen.append(("renamed", _mode(Path(source))))
        real_replace(source, target)
        seen.append(("in place", _mode(Path(target))))

    monkeypatch.setattr(tempfile, "mkstemp", mkstemp)
    monkeypatch.setattr(os, "replace", replace)
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert [stage for stage, _seen in seen] == ["created", "renamed", "in place"]
    assert all(mode & 0o077 == 0 for _stage, mode in seen), seen
    assert seen[1][1] == seen[2][1] == _mode(path) == 0o600


@posix_only
@pytest.mark.parametrize("bits", [0o644, 0o640, 0o664, 0o444, 0o755, 0o600, 0o4644, 0o2644])
def test_a_rewritten_credentials_file_is_owner_only_whatever_its_old_bits(umask, bits):
    """G-3 governs a rewrite (0.1.6 Batch 2B-2, owner decision Option A; it supersedes 0.1.5's S2 repair for
    Unified Storage). A file still owner-only (`0600`) is rewritten and stays `0600`. A file another account may
    reach is refused before anything is written, in one sentence that names it as messages do, and is left as it
    was: content, bits, and no temp file. Nothing repairs, or widens, a permission."""
    from bugpilot.core.storage import StorageError

    umask(0o022)
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    try:
        path.chmod(bits)
    except OSError:
        pytest.skip(f"the system would not set {oct(bits)} on a file")
    if bits == 0o600:
        user_config.save_jira_site("https://other.example.invalid")
        assert _mode(path) == 0o600
        assert "https://other.example.invalid" in path.read_text(encoding="utf-8")
        return
    before, mode = path.read_bytes(), _mode(path)
    assert mode & 0o077, f"{oct(bits)} was meant to reach another account; the system set {oct(mode)}"
    with pytest.raises(StorageError) as refused:
        user_config.save_jira_site("https://other.example.invalid")
    message = str(refused.value)
    assert path.read_bytes() == before and _mode(path) == mode
    assert _temp_files(path.parent) == []
    assert "BUGPILOT_HOME/config/config.toml" in message and "Nothing was written" in message
    for private in (TOKEN, EMAIL, str(path.parent)):
        assert private not in message


@posix_only
def test_only_a_private_write_ignores_the_old_bits(tmp_path, umask):
    """The private rule is the credentials file's alone: an ordinary rewrite still keeps the target's bits (§43.11)."""
    umask(0o022)
    ordinary, private = tmp_path / "ordinary.json", tmp_path / "private.toml"
    for path in (ordinary, private):
        path.write_text("old\n", encoding="utf-8")
        path.chmod(0o644)
    atomic_write_text(ordinary, "new\n")
    atomic_write_text(private, "new\n", private=True)
    assert (_mode(ordinary), _mode(private)) == (0o644, 0o600)


@posix_only
def test_a_concurrent_observer_never_sees_the_file_readable_or_half_written(umask):
    """A second thread lists the folder and reads every entry while the file is written forty times: no entry it
    sees is readable by others, and every read of the file is one whole version. Supplementary to the
    deterministic test above — an observer samples, it cannot see every instant."""
    umask(0o022)
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    folder = path.parent
    versions = {EXPECTED_TOML}
    sites = [f"https://site{index}.example.invalid" for index in range(40)]
    for site in sites:
        versions.add(f'jira_email = "{EMAIL}"\njira_base_url = "{site}"\njira_token = "{TOKEN}"\n')
    exposed: list[tuple[str, int]] = []
    torn: list[str] = []
    looks = 0
    stop = threading.Event()

    def observe() -> None:
        nonlocal looks
        while not stop.is_set():
            for entry in os.scandir(folder):
                try:
                    mode = stat.S_IMODE(entry.stat(follow_symlinks=False).st_mode)
                except FileNotFoundError:
                    continue
                looks += 1
                if mode & 0o077:
                    exposed.append((entry.name, mode))
            try:
                text = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            if text not in versions:
                torn.append(text[:40])

    thread = threading.Thread(target=observe)
    thread.start()
    try:
        for site in sites:
            user_config.save_user_config(EMAIL, TOKEN, site)
    finally:
        stop.set()
        thread.join()
    assert exposed == [] and torn == [] and looks > 0


# --- O4: a link at the file's own path ---------------------------------------------------------------


def _refusal(writer: str) -> str:
    with pytest.raises(UnsafePathError) as caught:
        _save(writer)
    return str(caught.value)


@pytest.mark.parametrize("writer", ["save_user_config", "save_jira_site"])
def test_a_link_to_a_file_at_the_credentials_path_is_refused(tmp_path, writer, user_config_folder):
    outside = tmp_path / "outside" / "token-sink.toml"
    outside.parent.mkdir()
    outside.write_bytes(b"untouched\n")
    path = user_config.user_config_path()
    assert path.parent == user_config_folder  # made private, as BugPilot makes it
    _link_file(path, outside)
    message = _refusal(writer)
    assert outside.read_bytes() == b"untouched\n"
    assert path.is_symlink() and _link_target(path) == str(outside)
    assert _temp_files(path.parent) == []
    assert "BUGPILOT_HOME/config/config.toml" in message and "Nothing was written" in message
    for private in (TOKEN, EMAIL, str(tmp_path), "untouched"):
        assert private not in message


def test_the_site_writer_reads_nothing_through_a_link_at_the_credentials_path(tmp_path, monkeypatch, user_config_folder):
    """Final review: `save_jira_site` reads the file before it writes it, and used to read it through the link
    the write then refused. The refusal now comes first — nothing behind the link is opened at all."""
    import pathlib

    sink = tmp_path / "token-sink.toml"
    sink.write_bytes(b'jira_token = "elsewhere"\n')
    path = user_config.user_config_path()
    assert path.parent == user_config_folder  # made private, as BugPilot makes it
    _link_file(path, sink)
    read: list[str] = []
    real_read_text = pathlib.Path.read_text

    def recording(self, *args, **kwargs):
        read.append(os.path.normcase(str(self)))
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "read_text", recording)
    with pytest.raises(UnsafePathError):
        user_config.save_jira_site(SITE)
    assert os.path.normcase(str(path)) not in read and os.path.normcase(str(sink)) not in read


@posix_only
def test_a_link_to_a_fifo_at_the_credentials_path_is_refused_without_blocking(tmp_path, user_config_folder):
    """On POSIX a read through a link to a FIFO would block until something wrote to it: the refusal comes
    before any read, so the writer returns at once."""
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    path = user_config.user_config_path()
    assert path.parent == user_config_folder  # made private, as BugPilot makes it
    path.symlink_to(fifo)
    outcome: list[BaseException] = []

    def write() -> None:
        try:
            user_config.save_jira_site(SITE)
        except BaseException as error:  # recorded, asserted below
            outcome.append(error)

    thread = threading.Thread(target=write, daemon=True)
    thread.start()
    thread.join(5.0)
    if thread.is_alive():  # unblock the read so the test run can end, then fail
        with open(fifo, "w", encoding="utf-8"):
            pass
        thread.join(5.0)
        pytest.fail("the writer blocked on a read through the link")
    assert len(outcome) == 1 and isinstance(outcome[0], UnsafePathError)


def test_a_dangling_link_at_the_credentials_path_is_refused_and_creates_nothing(tmp_path, user_config_folder):
    nowhere = tmp_path / "nowhere" / "token-sink.toml"
    path = user_config.user_config_path()
    assert path.parent == user_config_folder  # made private, as BugPilot makes it
    _link_file(path, nowhere)
    _refusal("save_user_config")
    assert not nowhere.exists() and not nowhere.parent.exists()
    assert path.is_symlink() and _temp_files(path.parent) == []


def test_a_link_to_a_folder_at_the_credentials_path_is_refused(tmp_path, user_config_folder):
    """A junction on Windows, which any account can make."""
    sink = tmp_path / "sink"
    sink.mkdir()
    (sink / "keep.txt").write_bytes(b"keep\n")
    path = user_config.user_config_path()
    assert path.parent == user_config_folder  # made private, as BugPilot makes it
    _link_dir(path, sink)
    _refusal("save_user_config")
    assert sorted(os.listdir(sink)) == ["keep.txt"] and (sink / "keep.txt").read_bytes() == b"keep\n"
    assert _temp_files(path.parent) == []


def test_the_folder_holding_the_file_may_sit_behind_a_link(tmp_path, monkeypatch):
    """The policy, kept by decision B4-2: as a repository root may (§44.10), the folder holding the file may sit
    behind a link — dotfiles often do — and the file is written, owner-only, in the real folder. Since 0.1.6
    Batch 2B-2 that folder is the data folder `BUGPILOT_HOME` names; its `config/` is BugPilot's own, and a link
    there is refused. Only the file's own path is judged (O4). A folder someone else controls is outside the
    guarantee."""
    real = tmp_path / "real-data"
    real.mkdir()
    _link_dir(tmp_path / "linked-data", real)
    monkeypatch.setenv("BUGPILOT_HOME", str(tmp_path / "linked-data"))
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert (real / "config" / "config.toml").read_bytes().decode("utf-8").replace("\r\n", "\n") == EXPECTED_TOML
    if POSIX:
        assert _mode(real / "config" / "config.toml") == 0o600
    # Named in the real folder: storage hands out the canonical path, where the write landed.
    assert path == Path(os.path.realpath(real)) / "config" / "config.toml"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS's /tmp is a link into /private")
def test_on_macos_a_config_folder_under_tmp_is_not_refused(monkeypatch):
    folder = Path("/tmp") / f"bugpilot-data-{uuid.uuid4().hex}"
    monkeypatch.setenv("BUGPILOT_HOME", str(folder))
    try:
        path = user_config.save_user_config(EMAIL, TOKEN, SITE)
        assert str(path.resolve()).startswith("/private/") and _mode(path) == 0o600
    finally:
        shutil.rmtree(folder.resolve(), ignore_errors=True)


@posix_only
def test_a_link_swapped_in_while_the_file_is_written_is_never_written_through(tmp_path):
    """A second thread puts a link at the file's path and takes it away again, each time with one rename, while
    the file is written a hundred times. Whatever the interleaving, the link's target is never written: the check
    refuses a link it sees, and the write's own rename replaces a link it does not see rather than following it —
    and a private write has no in-place fallback that could. The target stays byte for byte as it was."""
    sink = tmp_path / "token-sink.toml"
    sink.write_bytes(b"untouched\n")
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    stop = threading.Event()
    swaps = 0

    def swap() -> None:
        nonlocal swaps
        while not stop.is_set():
            link = path.parent / f"link-{uuid.uuid4().hex}"
            link.symlink_to(sink)
            os.replace(link, path)
            swaps += 1

    thread = threading.Thread(target=swap)
    thread.start()
    refused = written = 0
    try:
        for index in range(100):
            try:
                user_config.save_user_config(EMAIL, TOKEN, f"https://site{index}.example.invalid")
                written += 1
            except UnsafePathError:
                refused += 1
    finally:
        stop.set()
        thread.join()
    assert sink.read_bytes() == b"untouched\n"
    assert swaps > 0 and refused + written == 100
    assert _temp_files(path.parent) == []


# --- the atomic writer's failure paths (every caller) ------------------------------------------------


@pytest.mark.parametrize("writer", ["credentials", "ordinary"])
def test_a_dangling_link_planted_at_the_temp_name_is_never_written_through(tmp_path, monkeypatch, writer, user_config_folder):
    """Found in Batch 4: Windows' exclusive create (`O_EXCL`) follows a *dangling* link and creates its target;
    POSIX's refuses it. A link planted at the temp file's name — here at the very name the writer gets — so never
    receives what is written: on POSIX the create fails; on Windows the writer sees that the file it opened is not
    the one at its name, and refuses before writing a byte."""
    sink = tmp_path / "elsewhere" / "sink.toml"
    sink.parent.mkdir()
    real_mkstemp = tempfile.mkstemp
    planted: list[str] = []

    def mkstemp(*args, **kwargs):
        name = os.path.join(kwargs["dir"], f"{kwargs['prefix']}planted{kwargs['suffix']}")
        try:
            os.symlink(sink, name)
        except OSError:
            pytest.skip("symbolic links need a privilege this account does not have")
        planted.append(name)
        return os.open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600), name

    monkeypatch.setattr(tempfile, "mkstemp", mkstemp)
    if writer == "credentials":
        from bugpilot.core.errors import StorageAccessError

        target, secret = user_config.user_config_path(), TOKEN
        assert target.parent == user_config_folder  # made private, as BugPilot makes it
        save = lambda: user_config.save_user_config(EMAIL, TOKEN, SITE)  # noqa: E731
        # The credentials writer reports a failed create as storage unavailable (0.1.6 Batch 2B-2, C-1 M-1): POSIX's
        # refused exclusive create arrives as StorageAccessError; Windows' own check still refuses as before.
        expected = StorageAccessError if POSIX else UnsafePathError
    else:
        target, secret = tmp_path / "run.json", "run-record-JR-12345"
        save = lambda: atomic_write_text(target, secret)  # noqa: E731
        expected = (UnsafePathError, FileExistsError)
    with pytest.raises(expected) as caught:
        save()
    assert real_mkstemp is not tempfile.mkstemp and planted
    assert not os.path.lexists(target)
    assert not sink.exists() or secret not in sink.read_text(encoding="utf-8"), "the secret went through the link"
    if not POSIX:
        assert sink.read_bytes() == b"", "Windows created the target, empty; nothing was written into it"
        assert not os.path.lexists(planted[0]), "the writer's own name, a link, is removed"
    if writer == "credentials":
        assert type(caught.value) is expected
        if POSIX:  # the planted link is left as it was, still dangling: nothing was created through it
            assert os.path.islink(planted[0]) and _link_target(Path(planted[0])) == str(sink) and not sink.exists()
        leftover = [Path(planted[0]).name] if POSIX else []
        assert _temp_files(target.parent) == leftover, "no partial credentials file or temp file of BugPilot's own"



@pytest.mark.parametrize("private", [False, True], ids=["ordinary", "private"])
def test_a_write_that_fails_leaves_the_target_and_no_temp_file(tmp_path, private):
    """A lone surrogate cannot be written as UTF-8: the write fails mid-way, after the temp file exists."""
    target = tmp_path / "target.toml"
    target.write_bytes(b"before\n")
    with pytest.raises(UnicodeEncodeError):
        atomic_write_text(target, "after " + chr(0xD800), private=private)
    assert target.read_bytes() == b"before\n" and _temp_files(tmp_path) == []


@pytest.mark.parametrize("private", [False, True], ids=["ordinary", "private"])
def test_a_rename_that_fails_leaves_the_target_and_no_temp_file(tmp_path, monkeypatch, private):
    target = tmp_path / "target.toml"
    target.write_bytes(b"before\n")

    def fail(source, destination):
        raise OSError(errno.EIO, "simulated I/O error")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError):
        atomic_write_text(target, "after\n", private=private)
    assert target.read_bytes() == b"before\n" and _temp_files(tmp_path) == []


def test_a_private_write_never_falls_back_in_place_on_posix(tmp_path, monkeypatch):
    """On POSIX a rename refused every time raises, and the old file — content and bits — is left as it was: an
    in-place write would keep its old bits or, for a new file, take the umask's. On Windows, which has no such
    bits, it falls back like any other file."""
    target = tmp_path / "config.toml"
    target.write_bytes(b"before\n")
    if POSIX:
        target.chmod(0o644)

    def refuse(source, destination):
        raise PermissionError(errno.EACCES, "simulated: in use")

    monkeypatch.setattr(os, "replace", refuse)
    monkeypatch.setattr(time, "sleep", lambda seconds: None)
    if POSIX:
        with pytest.raises(PermissionError):
            atomic_write_text(target, "after\n", private=True)
        assert target.read_bytes() == b"before\n" and _mode(target) == 0o644
    else:
        atomic_write_text(target, "after\n", private=True)
        assert target.read_text(encoding="utf-8") == "after\n"
    assert _temp_files(tmp_path) == []


def test_an_ordinary_write_still_falls_back_in_place(tmp_path, monkeypatch):
    """Unchanged for every other file: a rename that never succeeds ends in an in-place write (artifact_io)."""
    target = tmp_path / "run.json"
    target.write_bytes(b"before\n")

    def refuse(source, destination):
        raise PermissionError(errno.EACCES, "simulated: in use")

    monkeypatch.setattr(os, "replace", refuse)
    monkeypatch.setattr(time, "sleep", lambda seconds: None)
    atomic_write_text(target, "after\n")
    assert target.read_text(encoding="utf-8") == "after\n" and _temp_files(tmp_path) == []


def test_a_folder_at_the_credentials_path_is_an_error_and_is_left_as_it_was(user_config_folder):
    """On POSIX G-3 refuses it before anything is written: a credentials file must be a regular file (0.1.6
    Batch 2B-2, owner decision Option A). On Windows, whose privacy check reads access lists only, the write itself
    fails, as it always did."""
    from bugpilot.core.storage import StorageError

    path = user_config.user_config_path()
    path.mkdir()  # in the configuration folder made private, as BugPilot makes it
    (path / "inside.txt").write_bytes(b"inside\n")
    if POSIX:
        with pytest.raises(StorageError) as refused:
            user_config.save_user_config(EMAIL, TOKEN, SITE)
        assert type(refused.value) is StorageError and "it is not a regular file" in str(refused.value)
    else:
        with pytest.raises(OSError):
            user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert path.is_dir() and sorted(os.listdir(path)) == ["inside.txt"]
    assert (path / "inside.txt").read_bytes() == b"inside\n" and _temp_files(path.parent) == []


def test_writing_the_credentials_file_is_bounded():
    """One temp file, one rename, no retry on success: well inside any budget on any runner."""
    start = time.perf_counter()
    for index in range(50):
        user_config.save_user_config(EMAIL, TOKEN, f"https://site{index}.example.invalid")
    assert time.perf_counter() - start < 20.0
    assert _temp_files(user_config.user_config_path().parent) == []


# --- F13: task-preview reads nothing through a link ----------------------------------------------------


def _prepared_elsewhere(tmp_path: Path, monkeypatch, capsys) -> tuple[Path, str]:
    """A real prepared work item, in a repository other than the one previewed."""
    real = tmp_path / "real"
    (real / "src").mkdir(parents=True)
    (real / "src" / "selector.py").write_text("def remember_format():\n    pass\n", encoding="utf-8")
    monkeypatch.chdir(real)
    assert main(["bug", "--description", "remember_format loses the format.", "--prepare-only", "--json"]) == 0
    item = json.loads(capsys.readouterr().out)["work_item_id"]
    return real, item


@needs_rg
@pytest.mark.parametrize("linked", [".ai", "work-item"])
def test_f13_task_preview_reads_nothing_through_a_linked_folder(tmp_path, monkeypatch, capsys, linked):
    """Fixed in Batch 4 (F13, §43.7): `task-preview <id>` used to read `issue.json` — and the persisted Fix Mode —
    through a linked `.ai` or work-item folder. Refused now, before anything is read, as `context-preview` does."""
    real, item = _prepared_elsewhere(tmp_path, monkeypatch, capsys)
    repo = tmp_path / "repo"
    repo.mkdir()
    if linked == ".ai":
        _link_dir(repo / ".ai", real / ".ai")
    else:
        (repo / ".ai").mkdir()
        _link_dir(repo / ".ai" / item, real / ".ai" / item)
    with pytest.raises(TaskPreviewError) as caught:
        preview_work_item(repo, item)
    message = str(caught.value)
    assert caught.value.code == "INVALID_INPUT"
    assert f".ai/{item} is behind a link or junction, so nothing in it was read" in message
    assert str(tmp_path) not in message
    assert preview_context(repo, item).state == STATE_UNREADABLE, "the two previews refuse alike"
    monkeypatch.chdir(repo)
    assert main(["task-preview", item, "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False and payload["error"]["code"] == "INVALID_INPUT"


@needs_rg
def test_f13_a_link_at_issue_json_itself_is_refused(tmp_path, monkeypatch, capsys):
    real, item = _prepared_elsewhere(tmp_path, monkeypatch, capsys)
    repo = tmp_path / "repo"
    (repo / ".ai" / item).mkdir(parents=True)
    _link_file(repo / ".ai" / item / "issue.json", real / ".ai" / item / "issue.json")
    with pytest.raises(TaskPreviewError):
        preview_work_item(repo, item)


@needs_rg
def test_f13_a_real_work_item_previews_as_before(tmp_path, monkeypatch, capsys):
    real, item = _prepared_elsewhere(tmp_path, monkeypatch, capsys)
    preview = preview_work_item(real, item)
    assert preview.work_item == item and preview.prepared.task_current
