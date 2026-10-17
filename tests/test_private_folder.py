"""The read-only privacy check behind the credentials gate (0.1.6 Batch 2A, finding G-3; ``bugpilot/core/private_folder.py``).

Three layers:

- the rules, as pure functions over what was read (``_posix_evaluate``, ``_windows_evaluate``), on every system;
- Windows: real folders in ``tmp_path`` (icacls adds grants to those synthetic folders only) and security
  descriptors built from SDDL strings, parsed by the module's own reader;
- POSIX: real folders and files in ``tmp_path``.

Nothing here, and nothing in the module, ever changes a permission of anything outside ``tmp_path``.
"""

from __future__ import annotations

import ast
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from bugpilot.core import private_folder
from bugpilot.core.private_folder import PrivacyVerdict, _posix_evaluate, _windows_evaluate, verify_private

REPO = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
POSIX = os.name == "posix"

ME = "S-1-5-21-1000000001-1000000002-1000000003-1001"  # a synthetic account SID
OTHER = "S-1-5-21-1000000001-1000000002-1000000003-1002"
SY, BA, OW, CO = "S-1-5-18", "S-1-5-32-544", "S-1-3-4", "S-1-3-0"
USERS, EVERYONE, AUTH = "S-1-5-32-545", "S-1-1-0", "S-1-5-11"
FULL, READ_EXECUTE, MODIFY, SYNCHRONIZE = 0x1F01FF, 0x1200A9, 0x1301BF, 0x00100000
OI, CI, IO, INHERITED = 0x01, 0x02, 0x08, 0x10
ALLOW, DENY = 0, 1

OWNER_ONLY = [(ALLOW, OI | CI, FULL, SY), (ALLOW, OI | CI, FULL, BA), (ALLOW, OI | CI, FULL, OW)]
PROFILE = [(ALLOW, INHERITED | OI | CI, FULL, SY), (ALLOW, INHERITED | OI | CI, FULL, BA),
           (ALLOW, INHERITED | OI | CI, FULL, ME)]


# --- the Windows rule, on every system -----------------------------------------------------------------


@pytest.mark.parametrize(
    "owner, present, aces, role, state, reason",
    [
        (ME, True, OWNER_ONLY, "config-folder", "private", ""),
        (ME, True, PROFILE, "config-folder", "private", ""),  # Python 3.10/3.11: inherited from the user profile
        (BA, True, OWNER_ONLY, "config-folder", "private", ""),
        (SY, True, OWNER_ONLY, "config-folder", "private", ""),
        (ME, True, [], "config-folder", "private", ""),  # an empty access list: only the owner
        (ME, True, PROFILE + [(ALLOW, OI | CI, READ_EXECUTE, USERS)], "config-folder", "not-private",
         "Users has access to it and the files created in it and the folders created in it"),
        (ME, True, OWNER_ONLY + [(ALLOW, OI | IO, 0x120089, EVERYONE)], "config-folder", "not-private",
         "Everyone has access to the files created in it"),
        (ME, True, OWNER_ONLY + [(ALLOW, OI | CI | IO, FULL, CO)], "config-folder", "private", ""),
        (ME, True, OWNER_ONLY + [(DENY, 0, FULL, EVERYONE)], "config-folder", "private", ""),
        (ME, True, OWNER_ONLY + [(ALLOW, 0, SYNCHRONIZE, EVERYONE)], "config-folder", "private", ""),
        (ME, False, [], "config-folder", "not-private", "it has no access list"),
        (OTHER, True, OWNER_ONLY, "config-folder", "not-private", "owned by another account or group"),
        (None, True, OWNER_ONLY, "config-folder", "unverifiable", "its owner cannot be read"),
        (ME, True, OWNER_ONLY + [(5, 0, FULL, None)], "config-folder", "unverifiable", "of a kind this check does not read"),
        (ME, True, OWNER_ONLY + [(9, 0, FULL, None)], "config-folder", "unverifiable", "of a kind this check does not read"),
        (ME, True, OWNER_ONLY + [(ALLOW, 0, FULL, None)], "config-folder", "unverifiable", "cannot be read"),
        # The data root: others may list it, never write to it.
        (ME, True, PROFILE + [(ALLOW, OI | CI, READ_EXECUTE, USERS)], "data-root", "private", ""),
        (ME, True, PROFILE + [(ALLOW, OI | CI, MODIFY, AUTH)], "data-root", "not-private",
         "Authenticated Users may write to it"),
        (ME, True, PROFILE + [(ALLOW, OI | CI | IO, MODIFY, AUTH)], "data-root", "private", ""),  # only new children
        (OTHER, True, PROFILE, "data-root", "not-private", "owned by another account or group"),
        # The credentials file: an entry that only reaches children does not apply to a file.
        (ME, True, PROFILE + [(ALLOW, 0, 0x120089, USERS)], "credential-file", "not-private", "Users has access to it"),
        (ME, True, PROFILE + [(ALLOW, IO | OI, FULL, EVERYONE)], "credential-file", "private", ""),
    ],
)
def test_the_windows_rule(owner, present, aces, role, state, reason):
    verdict = _windows_evaluate(owner, present, aces, ME, role)
    assert verdict.state == state, verdict
    assert reason in "; ".join(verdict.reasons)
    assert ME not in "; ".join(verdict.reasons) and OTHER not in "; ".join(verdict.reasons)  # never a SID


# --- the POSIX rule, on every system -------------------------------------------------------------------

DIR, FILE, LINK = stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK


@pytest.mark.parametrize(
    "mode, owner, role, state, reason",
    [
        (DIR | 0o700, 1000, "config-folder", "private", ""),
        (DIR | 0o750, 1000, "config-folder", "not-private", "its group has access to it"),
        (DIR | 0o701, 1000, "config-folder", "not-private", "every other account has access to it"),
        (DIR | 0o700, 0, "config-folder", "not-private", "owned by another account"),
        (DIR | 0o755, 1000, "data-root", "private", ""),
        (DIR | 0o755, 0, "data-root", "private", ""),  # a root-owned folder the user was given
        (DIR | 0o775, 1000, "data-root", "not-private", "its group may write to it"),
        (DIR | 0o1777, 1000, "data-root", "not-private", "every other account may write to it"),  # no sticky exception
        (DIR | 0o755, 1001, "data-root", "not-private", "owned by another account"),
        (FILE | 0o600, 1000, "credential-file", "private", ""),
        (FILE | 0o640, 1000, "credential-file", "not-private", "its group has access to it"),
        (FILE | 0o604, 1000, "credential-file", "not-private", "every other account has access to it"),
        (LINK | 0o777, 1000, "credential-file", "not-private", "it is a symbolic link"),
        (DIR | 0o700, 1000, "credential-file", "not-private", "it is not a regular file"),
        (LINK | 0o777, 1000, "config-folder", "not-private", "it is a symbolic link"),
        (FILE | 0o600, 1000, "config-folder", "not-private", "it is not a folder"),
    ],
)
def test_the_posix_rule(mode, owner, role, state, reason):
    verdict = _posix_evaluate(mode, owner, 1000, role)
    assert verdict.state == state, verdict
    assert reason in "; ".join(verdict.reasons)


def test_a_verdict_is_private_only_when_proven():
    assert PrivacyVerdict("private").private
    assert not PrivacyVerdict("not-private", ("x",)).private
    assert not PrivacyVerdict("unverifiable", ("x",)).private


# --- nothing is ever changed --------------------------------------------------------------------------

_CHANGES_PERMISSIONS = re.compile(
    r"\b(?:Set\w*Security\w*|SetEntriesInAcl\w*|TreeSetNamedSecurityInfo\w*|icacls|cacls)\b"
    r"|\bos\.(?:chmod|lchmod|fchmod|chown|lchown|fchown)\b|\.chmod\(|\.lchmod\("
)


def _code_only(path: Path) -> str:
    """The module's source without docstrings and comments: a mention is not a call."""
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    lines = source.split("\n")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                for index in range(body[0].lineno - 1, body[0].end_lineno or body[0].lineno):
                    lines[index] = ""
    return "\n".join(line.split("#")[0] for line in lines)


@pytest.mark.parametrize("module", ["private_folder.py", "storage.py"])
def test_no_permission_is_ever_changed(module):
    """The check reads and answers; neither it nor storage loosens, tightens or re-owns anything."""
    found = _CHANGES_PERMISSIONS.findall(_code_only(REPO / "bugpilot" / "core" / module))
    assert found == [], found


# --- Windows: real folders and SDDL descriptors --------------------------------------------------------


def _python_applies_mode_0700() -> bool:
    version = sys.version_info[:3]
    return version >= (3, 13) or (3, 12, 4) <= version < (3, 13) or (3, 11, 10) <= version < (3, 12) or (3, 10, 15) <= version < (3, 11)


windows_only = pytest.mark.skipif(not WINDOWS, reason="Windows access lists")
mode_applied = pytest.mark.skipif(
    WINDOWS and not _python_applies_mode_0700(),
    reason="this Python ignores mode on Windows (before 3.10.15, 3.11.10, 3.12.4): the rule tables cover it",
)


def _grant(path: Path, grant: str) -> None:
    subprocess.run(["icacls", str(path), "/grant", grant], check=True, capture_output=True)


@windows_only
@mode_applied
def test_a_folder_made_owner_only_is_private_and_a_grant_to_users_is_seen(tmp_path):
    folder = tmp_path / "config"
    os.mkdir(folder, 0o700)
    assert verify_private(folder, "config-folder").private
    assert verify_private(folder, "data-root").private
    before = private_folder._read_security(str(folder))
    assert verify_private(folder, "config-folder") == verify_private(folder, "config-folder")
    assert private_folder._read_security(str(folder)) == before  # reading changes nothing
    _grant(folder, "*S-1-5-32-545:(OI)(CI)(RX)")
    verdict = verify_private(folder, "config-folder")
    assert verdict.state == "not-private" and "Users has access to it" in verdict.reasons[0]
    assert verify_private(folder, "data-root").private  # reading and listing do not let Users swap anything


@windows_only
@mode_applied
def test_a_grant_that_only_reaches_new_files_is_seen(tmp_path):
    folder = tmp_path / "config"
    os.mkdir(folder, 0o700)
    _grant(folder, "*S-1-1-0:(OI)(IO)(R)")
    verdict = verify_private(folder, "config-folder")
    assert verdict.state == "not-private" and "Everyone has access to the files created in it" in verdict.reasons


@windows_only
@mode_applied
def test_a_credentials_file_inherits_its_folders_privacy_and_a_grant_on_it_is_seen(tmp_path):
    folder = tmp_path / "config"
    os.mkdir(folder, 0o700)
    credentials = folder / "config.toml"
    credentials.write_text("synthetic\n", encoding="utf-8")
    assert verify_private(credentials, "credential-file").private
    _grant(credentials, "*S-1-5-11:(R)")
    verdict = verify_private(credentials, "credential-file")
    assert verdict.state == "not-private" and "Authenticated Users has access to it" in verdict.reasons


def _from_sddl(sddl: str):
    """Owner SID, DACL presence and entries of a descriptor built in memory from SDDL: no file is involved."""
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    advapi32.GetSecurityDescriptorOwner.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
                                                    ctypes.POINTER(wintypes.BOOL)]
    advapi32.GetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                                                   ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    assert advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None)
    try:
        owner, defaulted, present, dacl = ctypes.c_void_p(), wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
        assert advapi32.GetSecurityDescriptorOwner(descriptor, ctypes.byref(owner), ctypes.byref(defaulted))
        assert advapi32.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl),
                                                  ctypes.byref(defaulted))
        owner_sid = private_folder._sid_text(owner.value)
        if not present.value or not dacl.value:
            return owner_sid, False, []
        return owner_sid, True, private_folder._parse_acl(dacl.value)
    finally:
        kernel32.LocalFree(descriptor)


@windows_only
@pytest.mark.parametrize(
    "sddl, state, reason",
    [
        ("O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;OW)", "private", ""),
        ("O:SYD:P(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)", "not-private", "Users has access to it"),
        ("O:SYD:P(A;OICI;FA;;;SY)(D;OICI;FA;;;WD)", "private", ""),
        ("O:SYD:P(A;OICIIO;FA;;;CO)(A;OICI;FA;;;SY)", "private", ""),
        ("O:SYD:NO_ACCESS_CONTROL", "not-private", "it has no access list"),
        ("O:SYD:P(OA;;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;WD)", "unverifiable", "of a kind this check does not read"),
        ("O:WDD:P(A;OICI;FA;;;SY)", "not-private", "owned by Everyone"),
    ],
)
def test_descriptors_built_from_sddl_are_read_and_judged(sddl, state, reason):
    owner, present, aces = _from_sddl(sddl)
    verdict = _windows_evaluate(owner, present, aces, private_folder._current_user_sid(), "config-folder")
    assert verdict.state == state, verdict
    assert reason in "; ".join(verdict.reasons)


@windows_only
def test_a_volume_without_access_lists_or_an_api_failure_is_unverifiable(tmp_path, monkeypatch):
    monkeypatch.setattr(private_folder, "_volume_keeps_access_lists", lambda path: False)
    assert verify_private(tmp_path, "config-folder").state == "unverifiable"
    monkeypatch.undo()

    def failing(path):
        raise private_folder._Unreadable("its access list cannot be read (Windows error 5)")

    monkeypatch.setattr(private_folder, "_read_security", failing)
    verdict = verify_private(tmp_path, "config-folder")
    assert verdict.state == "unverifiable" and "Windows error 5" in verdict.reasons[0]


@windows_only
def test_a_path_that_does_not_exist_is_unverifiable(tmp_path):
    assert verify_private(tmp_path / "missing", "config-folder").state == "unverifiable"


# --- POSIX: real folders and files ---------------------------------------------------------------------

posix_only = pytest.mark.skipif(not POSIX, reason="permission bits are POSIX's")


@posix_only
def test_real_folders_and_files_are_judged_and_their_bits_left_alone(tmp_path):
    folder = tmp_path / "config"
    folder.mkdir(mode=0o700)
    os.chmod(folder, 0o700)
    credentials = folder / "config.toml"
    credentials.write_text("synthetic\n", encoding="utf-8")
    os.chmod(credentials, 0o600)
    assert verify_private(folder, "config-folder").private
    assert verify_private(credentials, "credential-file").private
    os.chmod(folder, 0o750)
    os.chmod(credentials, 0o644)
    assert verify_private(folder, "config-folder").state == "not-private"
    assert verify_private(credentials, "credential-file").state == "not-private"
    assert stat.S_IMODE(os.stat(folder).st_mode) == 0o750  # never changed
    assert stat.S_IMODE(os.stat(credentials).st_mode) == 0o644


@posix_only
def test_a_link_at_the_credentials_file_is_not_private(tmp_path):
    target = tmp_path / "elsewhere.toml"
    target.write_text("synthetic\n", encoding="utf-8")
    os.chmod(target, 0o600)
    link = tmp_path / "config.toml"
    os.symlink(target, link)
    assert verify_private(link, "credential-file").reasons == ("it is a symbolic link",)


@posix_only
def test_another_owner_is_not_private(tmp_path, monkeypatch):
    folder = tmp_path / "config"
    folder.mkdir(mode=0o700)
    monkeypatch.setattr(private_folder.os, "geteuid", lambda: os.stat(folder).st_uid + 1)
    assert "it is owned by another account" in verify_private(folder, "config-folder").reasons


@posix_only
def test_a_path_that_cannot_be_examined_is_unverifiable(tmp_path):
    assert verify_private(tmp_path / "missing", "config-folder").state == "unverifiable"
