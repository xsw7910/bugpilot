"""Is a folder or file private to this user? A read-only check, for the places that hold credentials.

BugPilot keeps the Jira token in ``config/config.toml`` under its data folder
(0.1.6 plan §6.1). Before that file is written, :mod:`storage` asks this module
whether the data folder, ``config/`` and the file itself are private (Batch 2A,
finding G-3). It never makes them private: it reads, and answers. Nothing here
changes an access list, an owner or a permission bit.

Three answers (:class:`PrivacyVerdict`):

- ``private``: proven from what is on disk;
- ``not-private``: another account can reach it. The reasons name kinds of
  account (``Users``, ``another account or group``), never a name or a SID;
- ``unverifiable``: it cannot be proven either way (a volume without access
  lists, an access entry this check does not read, an API failure). Callers
  treat it as not private: fail closed.

What "private" means depends on the role:

- ``data-root``: owned by this user (or, on POSIX, root; on Windows, SYSTEM or
  Administrators), and no one else may *write* to it, so the folders in it
  cannot be swapped. Others may still list it.
- ``config-folder``: owned by this user (on Windows also SYSTEM or
  Administrators), and no one else has any access to it, or to the files and
  folders created in it.
- ``credential-file``: a regular file, not a link, owned by this user (on
  Windows also SYSTEM or Administrators), that no one else can read or write.

**Windows.** The owner and the access list (DACL), read with
``GetNamedSecurityInfoW``. Trusted: this user, SYSTEM, Administrators and
OWNER RIGHTS. A CREATOR OWNER entry stands for the creator, so it is passed
over; so are deny entries (they only narrow access) and grants of nothing but
SYNCHRONIZE, READ_CONTROL and FILE_READ_ATTRIBUTES. Inherited entries count
like any other, and so do entries that only reach the files and folders created
later. An entry of any other kind is not read: unverifiable. The answer comes
from what is on disk, so it is the same on Python 3.10 and 3.11, where
``mkdir(mode=0o700)`` sets no access list, as on 3.12.4 and later, where it does.

**POSIX.** The owner and the permission bits. Linux ACL grants show in the
group bits (the ACL mask), so they are seen.

**Stated gaps.** macOS extended ACLs (``chmod +a``) are not read. The folders
above the data root are not checked. A network share answers with whatever
access list its server reports, and only if it reports one.

Standard library only (``ctypes`` on Windows, loaded only there).
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

Role = Literal["data-root", "config-folder", "credential-file"]
State = Literal["private", "not-private", "unverifiable"]

# --- Windows constants (winnt.h, accctrl.h) ---------------------------------------------------------

_SE_FILE_OBJECT = 1
_OWNER_SECURITY_INFORMATION = 0x1
_DACL_SECURITY_INFORMATION = 0x4
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_FILE_PERSISTENT_ACLS = 0x00000008
_ACCESS_ALLOWED_ACE_TYPE = 0
_ACCESS_DENIED_ACE_TYPE = 1
_OBJECT_INHERIT_ACE = 0x01
_CONTAINER_INHERIT_ACE = 0x02
_INHERIT_ONLY_ACE = 0x08
#: Rights that reveal or change nothing that matters here.
_HARMLESS = 0x00100000 | 0x00020000 | 0x00000080  # SYNCHRONIZE, READ_CONTROL, FILE_READ_ATTRIBUTES
#: Rights that let an account add, remove, rename or re-permission what is in a folder.
_WRITE_RIGHTS = (
    0x00000002  # FILE_WRITE_DATA / FILE_ADD_FILE
    | 0x00000004  # FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
    | 0x00000010  # FILE_WRITE_EA
    | 0x00000040  # FILE_DELETE_CHILD
    | 0x00000100  # FILE_WRITE_ATTRIBUTES
    | 0x00010000  # DELETE
    | 0x00040000  # WRITE_DAC
    | 0x00080000  # WRITE_OWNER
    | 0x02000000  # MAXIMUM_ALLOWED
    | 0x10000000  # GENERIC_ALL
    | 0x40000000  # GENERIC_WRITE
)
_SYSTEM = "S-1-5-18"
_ADMINISTRATORS = "S-1-5-32-544"
_OWNER_RIGHTS = "S-1-3-4"
_CREATOR_OWNER = "S-1-3-0"
#: How a reason names a well-known account or group; any other is "another account or group".
_KINDS = {
    "S-1-1-0": "Everyone",
    "S-1-5-11": "Authenticated Users",
    "S-1-5-32-545": "Users",
    "S-1-5-32-546": "Guests",
    "S-1-5-32-547": "Power Users",
    "S-1-5-32-555": "Remote Desktop Users",
    "S-1-5-4": "interactive users",
    "S-1-5-2": "network users",
    "S-1-5-7": "anonymous users",
    "S-1-3-1": "the creator's group",
}

#: One access entry as read: (type, flags, access mask, SID text or None when it cannot be read).
Ace = tuple[int, int, int, "str | None"]


@dataclass(frozen=True)
class PrivacyVerdict:
    """The answer of :func:`verify_private`. ``reasons`` never hold a path, an account name or a SID."""

    state: State
    reasons: tuple[str, ...] = ()

    @property
    def private(self) -> bool:
        return self.state == "private"


def verify_private(path: str | os.PathLike[str], role: Role) -> PrivacyVerdict:
    """Whether ``path`` is private to this user in the sense of ``role``. Read only; never raises for a missing answer."""
    if os.name == "nt":
        return _windows_verdict(Path(path), role)
    return _posix_verdict(Path(path), role)


# --- POSIX -------------------------------------------------------------------------------------------


def _posix_verdict(path: Path, role: Role) -> PrivacyVerdict:
    try:
        # The data root may be a link the user chose (owner decision B4-2): judge the folder it names.
        info = os.stat(path) if role == "data-root" else os.lstat(path)
    except OSError as error:
        return PrivacyVerdict("unverifiable", (f"it cannot be examined ({type(error).__name__})",))
    return _posix_evaluate(info.st_mode, info.st_uid, os.geteuid(), role)


def _posix_evaluate(mode: int, owner: int, euid: int, role: Role) -> PrivacyVerdict:
    """The POSIX rule on an ``lstat``/``stat`` result: pure, so every case is testable on every system."""
    if role == "credential-file":
        if stat.S_ISLNK(mode):
            return PrivacyVerdict("not-private", ("it is a symbolic link",))
        if not stat.S_ISREG(mode):
            return PrivacyVerdict("not-private", ("it is not a regular file",))
    elif not stat.S_ISDIR(mode):
        what = "a symbolic link" if stat.S_ISLNK(mode) else "not a folder"
        return PrivacyVerdict("not-private", (f"it is {what}",))
    reasons = []
    trusted_owners = {euid, 0} if role == "data-root" else {euid}
    if owner not in trusted_owners:
        reasons.append("it is owned by another account")
    if role == "data-root":
        if mode & 0o020:
            reasons.append("its group may write to it")
        if mode & 0o002:
            reasons.append("every other account may write to it")
    else:
        if mode & 0o070:
            reasons.append("its group has access to it")
        if mode & 0o007:
            reasons.append("every other account has access to it")
    return PrivacyVerdict("not-private" if reasons else "private", tuple(reasons))


# --- Windows -----------------------------------------------------------------------------------------


class _Unreadable(Exception):
    """The security information could not be read; the message is the verdict's reason."""


@lru_cache(maxsize=1)
def _win32():
    """The Win32 functions this module calls, each with its argument and result types declared.

    Without declared types ``ctypes`` passes handles and pointers as 32-bit
    integers, which truncates them on 64-bit Windows.
    """
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    pointer = ctypes.c_void_p
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [pointer]
    kernel32.LocalFree.restype = pointer
    kernel32.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel32.GetVolumePathNameW.restype = wintypes.BOOL
    kernel32.GetVolumeInformationW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD,
    ]
    kernel32.GetVolumeInformationW.restype = wintypes.BOOL
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.GetNamedSecurityInfoW.argtypes = [
        wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(pointer),
        ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.POINTER(pointer),
    ]
    advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi32.GetAce.argtypes = [pointer, wintypes.DWORD, ctypes.POINTER(pointer)]
    advapi32.GetAce.restype = wintypes.BOOL
    advapi32.IsValidSid.argtypes = [pointer]
    advapi32.IsValidSid.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    return ctypes, wintypes, advapi32, kernel32


def _windows_verdict(path: Path, role: Role) -> PrivacyVerdict:
    try:
        if not _volume_keeps_access_lists(str(path)):
            return PrivacyVerdict("unverifiable", ("its volume keeps no access lists (FAT or exFAT, for example)",))
        me = _current_user_sid()
        owner, dacl_present, aces = _read_security(str(path))
    except _Unreadable as error:
        return PrivacyVerdict("unverifiable", (str(error),))
    except OSError as error:  # the DLLs or a call failed in a way not anticipated: unknown, so not private
        return PrivacyVerdict("unverifiable", (f"its security information cannot be read ({type(error).__name__})",))
    return _windows_evaluate(owner, dacl_present, aces, me, role)


def _volume_keeps_access_lists(path: str) -> bool:
    ctypes, wintypes, _, kernel32 = _win32()
    volume = ctypes.create_unicode_buffer(32768)
    if not kernel32.GetVolumePathNameW(path, volume, len(volume)):
        raise _Unreadable("its volume cannot be identified")
    flags = wintypes.DWORD(0)
    if not kernel32.GetVolumeInformationW(volume.value, None, 0, None, None, ctypes.byref(flags), None, 0):
        raise _Unreadable("its volume's features cannot be read")
    return bool(flags.value & _FILE_PERSISTENT_ACLS)


def _sid_text(sid) -> str | None:
    """A SID's text form, or None when the pointer does not hold a valid SID."""
    ctypes, wintypes, advapi32, kernel32 = _win32()
    if not sid or not advapi32.IsValidSid(sid):
        return None
    text = wintypes.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        return None
    try:
        return text.value
    finally:
        kernel32.LocalFree(ctypes.cast(text, ctypes.c_void_p))


def _current_user_sid() -> str:
    ctypes, wintypes, advapi32, kernel32 = _win32()
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
        raise _Unreadable("this process's account cannot be read")
    try:
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(token, _TOKEN_USER, None, 0, ctypes.byref(size))
        if not size.value:
            raise _Unreadable("this process's account cannot be read")
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, _TOKEN_USER, buffer, size, ctypes.byref(size)):
            raise _Unreadable("this process's account cannot be read")
        sid = _sid_text(ctypes.c_void_p.from_buffer(buffer).value)  # TOKEN_USER.User.Sid comes first
        if sid is None:
            raise _Unreadable("this process's account cannot be read")
        return sid
    finally:
        kernel32.CloseHandle(token)


def _read_security(path: str) -> tuple[str | None, bool, list[Ace]]:
    """The owner's SID, whether a DACL is present, and its entries. Frees what Windows allocated."""
    ctypes, _, advapi32, kernel32 = _win32()
    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    status = advapi32.GetNamedSecurityInfoW(
        path, _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION,
        ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor),
    )
    if status != 0:
        raise _Unreadable(f"its access list cannot be read (Windows error {status})")
    try:
        owner_sid = _sid_text(owner.value)
        if not dacl.value:
            return owner_sid, False, []
        return owner_sid, True, _parse_acl(dacl.value)
    finally:
        kernel32.LocalFree(descriptor)


def _parse_acl(acl) -> list[Ace]:
    """Every entry of an ACL, in order. Entries of a kind this check does not read keep a mask of 0 and no SID."""
    ctypes, wintypes, advapi32, _ = _win32()
    count = ctypes.cast(acl, ctypes.POINTER(wintypes.WORD))[2]  # ACL: revision, sbz1 (bytes), size, AceCount
    entries: list[Ace] = []
    for index in range(count):
        ace = ctypes.c_void_p()
        if not advapi32.GetAce(acl, index, ctypes.byref(ace)):
            raise _Unreadable("an entry of its access list cannot be read")
        header = ctypes.cast(ace, ctypes.POINTER(ctypes.c_ubyte))
        ace_type, flags = header[0], header[1]
        if ace_type in (_ACCESS_ALLOWED_ACE_TYPE, _ACCESS_DENIED_ACE_TYPE):
            mask = ctypes.cast(ace.value + 4, ctypes.POINTER(wintypes.DWORD))[0]  # after the 4-byte header
            entries.append((ace_type, flags, mask, _sid_text(ace.value + 8)))  # the SID follows the mask
        else:
            entries.append((ace_type, flags, 0, None))
    return entries


def _windows_evaluate(owner: str | None, dacl_present: bool, aces: list[Ace], me: str, role: Role) -> PrivacyVerdict:
    """The Windows rule on what was read: pure, so every case is testable on every system."""
    if owner is None:
        return PrivacyVerdict("unverifiable", ("its owner cannot be read",))
    reasons = []
    if owner not in {me, _SYSTEM, _ADMINISTRATORS}:
        reasons.append(f"it is owned by {_kind(owner)}, who can change its access list")
    if not dacl_present:
        return PrivacyVerdict("not-private", (*reasons, "it has no access list, so every account has full access"))
    trusted = {me, _SYSTEM, _ADMINISTRATORS, _OWNER_RIGHTS, _CREATOR_OWNER}
    for ace_type, flags, mask, sid in aces:
        if ace_type == _ACCESS_DENIED_ACE_TYPE:
            continue  # a denial only narrows
        if ace_type != _ACCESS_ALLOWED_ACE_TYPE:
            return PrivacyVerdict("unverifiable", ("it has an access entry of a kind this check does not read",))
        if sid is None:
            return PrivacyVerdict("unverifiable", ("an access entry names an account that cannot be read",))
        if sid in trusted:
            continue
        reach = _reach(flags, role)
        rights = mask & ~_HARMLESS
        if role == "data-root":
            rights &= _WRITE_RIGHTS
        if reach and rights:
            verb = "may write to" if role == "data-root" else "has access to"
            reasons.append(f"{_kind(sid)} {verb} {reach}")
    return PrivacyVerdict("not-private" if reasons else "private", tuple(reasons))


def _reach(flags: int, role: Role) -> str:
    """What an entry with these flags applies to, in words; empty when it applies to nothing that matters."""
    applies_here = not flags & _INHERIT_ONLY_ACE
    if role != "config-folder":
        return "it" if applies_here else ""  # a file has no children; for the data root only the folder matters
    parts = ["it"] if applies_here else []
    if flags & _OBJECT_INHERIT_ACE:
        parts.append("the files created in it")
    if flags & _CONTAINER_INHERIT_ACE:
        parts.append("the folders created in it")
    return " and ".join(parts)


def _kind(sid: str) -> str:
    return _KINDS.get(sid, "another account or group")
