"""Request-scope invariants (0.1.6 Batch 2B-1, finding C-2; ``storage.request_scope``).

A request scope decides how long containment, Git working-tree and record
verdicts may be trusted. These tests pin what a scope is: a new set of
verdicts per request, dropped at its end whatever ends it, joined by nested
scopes in the same thread, and never shared between requests, not even
through a context copied into a worker thread, which is how the MCP server
runs its tools (``anyio.to_thread.run_sync``).

What these tests do NOT show: that the MCP server opens a scope per tool
call. It does not yet. Wiring that inside the worker thread is a mandatory
Batch 2B-5 gate; until then only the storage side of the contract is proven.
"""

from __future__ import annotations

import asyncio
import contextvars
import sys
import threading
from pathlib import Path

import pytest

from bugpilot.core import storage
from bugpilot.core.storage import global_storage, request_scope


@pytest.fixture(autouse=True)
def no_scope_before_or_after():
    assert storage._scope.get() is None
    yield
    assert storage._scope.get() is None


def _counting(key: str) -> tuple[list[int], object]:
    """A verdict whose computations are counted."""
    calls: list[int] = []

    def compute() -> int:
        calls.append(1)
        return len(calls)

    return calls, lambda: storage._scoped(("test", key), compute)


# --- one request: fresh, joined when nested, released however it ends -------------------------------


def test_every_request_gets_a_new_empty_scope_and_none_is_reused():
    seen = []
    for _ in range(3):
        with request_scope():
            scope = storage._active_scope()
            assert scope is not None and len(scope) == 0
            storage._scoped(("test", "x"), lambda: 1)
            seen.append(scope)
        assert storage._scope.get() is None
    assert len({id(scope) for scope in seen}) == 3  # all three alive in ``seen``, so ids cannot repeat


def test_a_verdict_is_computed_once_per_scope_and_every_time_outside_one():
    calls, verdict = _counting("once")
    verdict()
    verdict()
    assert len(calls) == 2  # outside a scope nothing is remembered
    with request_scope():
        verdict()
        verdict()
    assert len(calls) == 3
    with request_scope():
        verdict()
    assert len(calls) == 4  # a later scope never sees an earlier scope's verdict


def test_a_nested_scope_joins_the_outer_one_and_the_outer_one_decides_its_lifetime():
    calls, verdict = _counting("nested")
    with request_scope():
        outer = storage._active_scope()
        verdict()
        with request_scope():
            assert storage._active_scope() is outer
            verdict()  # remembered from the outer scope
        assert storage._active_scope() is outer and len(outer) == 1  # the inner end dropped nothing
        verdict()
    assert len(calls) == 1


def test_public_operations_share_the_callers_scope(tmp_path, monkeypatch):
    judged: list[str] = []
    real = storage._judge_git_tree

    def counted(*args):
        judged.append("git")
        return real(*args)

    monkeypatch.setattr(storage, "_judge_git_tree", counted)
    with request_scope():
        global_storage().config_file(create=False)
        global_storage().user_instructions_file(create=False)
    assert len(judged) == 1
    global_storage().config_file(create=False)
    global_storage().user_instructions_file(create=False)
    assert len(judged) == 3  # each call outside a scope opens, and ends, its own


def test_an_exception_releases_the_scope():
    with pytest.raises(RuntimeError):
        with request_scope():
            assert storage._active_scope() is not None
            raise RuntimeError("synthetic")
    assert storage._scope.get() is None


def test_an_exception_in_a_nested_scope_leaves_the_outer_one_intact():
    with request_scope():
        outer = storage._active_scope()
        with pytest.raises(RuntimeError):
            with request_scope():
                raise RuntimeError("synthetic")
        assert storage._active_scope() is outer


def test_a_cancelled_request_releases_its_scope():
    opened, after = [], []

    async def request() -> None:
        try:
            with request_scope():
                opened.append(storage._active_scope())
                await asyncio.sleep(60)
        except asyncio.CancelledError:
            after.append(storage._scope.get())
            raise

    async def main() -> None:
        task = asyncio.ensure_future(request())
        while not opened:
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert opened[0] is not None and after == [None]


# --- concurrent requests never share -------------------------------------------------------------------


def _in_threads(count: int, work) -> list[object]:
    results: list[object] = [None] * count
    errors: list[BaseException] = []

    def run(index: int) -> None:
        try:
            results[index] = work(index)
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=run, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert not any(thread.is_alive() for thread in threads) and errors == []
    return results


def test_requests_in_copied_contexts_on_worker_threads_get_separate_scopes():
    """The MCP dispatch model: each tool call runs ``copy_context().run(tool)`` in a worker thread."""
    barrier = threading.Barrier(6)

    def tool_call() -> object:
        with request_scope():
            scope = storage._active_scope()
            storage._scoped(("test", "shared?"), lambda: threading.get_ident())
            barrier.wait()  # all six requests are open at once
            return scope, dict(scope)

    base = contextvars.copy_context()  # a server's base context, no scope open in it
    results = _in_threads(6, lambda index: base.copy().run(tool_call))
    scopes = [scope for scope, _ in results]
    assert len({id(scope) for scope in scopes}) == 6
    assert all(len(verdicts) == 1 for _, verdicts in results)  # each holds only its own verdict


def test_a_scope_open_in_a_base_context_is_not_shared_by_requests_copied_from_it():
    """C-2: a copied context carries the very same scope object; it must count as no scope elsewhere."""
    calls, verdict = _counting("hazard")
    with request_scope():  # what a server must never do; if it did, requests would still not share
        base_scope = storage._active_scope()
        base = contextvars.copy_context()

        def tool_call() -> object:
            assert storage._scope.get() is base_scope  # the hazard: the copy holds the same object
            assert storage._active_scope() is None  # neutralised: it is not this thread's scope
            verdict()
            with request_scope():
                own = storage._active_scope()
                verdict()
                verdict()
            return own

        owns = _in_threads(4, lambda index: base.copy().run(tool_call))
        assert len({id(own) for own in owns}) == 4 and all(own is not base_scope for own in owns)
        assert len(base_scope) == 0  # nothing a request computed landed in the base scope
    assert len(calls) == 8  # per request: one outside its scope, one inside it


def test_a_thread_started_inside_a_request_starts_without_a_scope():
    """Whether threads inherit the context (``sys.flags.thread_inherit_context``) or not."""
    inherit = getattr(sys.flags, "thread_inherit_context", 0)
    with request_scope():
        mine = storage._active_scope()
        seen = _in_threads(1, lambda index: (storage._scope.get(), storage._active_scope()))
    inherited, active = seen[0]
    assert active is None
    assert inherited is (mine if inherit else None)


def test_asyncio_tasks_started_without_a_scope_get_separate_ones():
    scopes = []

    async def request() -> None:
        with request_scope():
            scopes.append(storage._active_scope())
            await asyncio.sleep(0.01)  # both requests are open at once

    async def main() -> None:
        await asyncio.gather(request(), request())

    asyncio.run(main())
    assert len(scopes) == 2 and scopes[0] is not scopes[1]


def test_asyncio_tasks_started_inside_an_open_scope_join_it_which_is_why_a_server_must_not_open_one():
    """The documented limit: tasks in one thread copy the context, so they join a scope already open in it."""
    scopes = []

    async def request() -> None:
        with request_scope():
            scopes.append(storage._active_scope())

    async def main() -> None:
        with request_scope():
            outer = storage._active_scope()
            await asyncio.gather(request(), request())
        assert len(scopes) == 2 and all(scope is outer for scope in scopes)  # identity: scopes are dicts

    asyncio.run(main())


def test_anyio_worker_threads_copy_the_context_and_still_start_without_a_scope():
    anyio = pytest.importorskip("anyio")
    found = []

    def tool_call() -> None:
        found.append((storage._scope.get(), storage._active_scope()))
        with request_scope():
            found.append(storage._active_scope())

    async def main() -> None:
        with request_scope():
            outer = storage._active_scope()
            await anyio.to_thread.run_sync(tool_call)
        copied, active = found[0]
        assert copied is outer and active is None
        assert found[1] is not None and found[1] is not outer

    anyio.run(main)


# --- the server's base context ---------------------------------------------------------------------------


def test_building_the_mcp_server_leaves_no_scope_behind(tmp_path: Path):
    pytest.importorskip("mcp")
    from bugpilot import mcp_server

    repo = tmp_path / "checkout"
    repo.mkdir()
    mcp_server.build_server(repo)
    assert storage._scope.get() is None
