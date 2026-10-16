"""Shared pytest fixtures.

Isolates the user-level BugPilot config so tests never read or write the real
``~/.bugpilot/config.toml`` (which would make results depend on whether the
developer has run ``bugpilot setup``), and the Jira credentials with it.

Since 0.1.6 Batch 0A (plan §11.1) the whole session is isolated first — before
pytest collects or imports a test module, so collection-time renders and
module-scoped fixtures already run inside it — and a guard refuses, before it
happens, any read or write of the developer's real BugPilot data
(``tests/_isolation.py``). Each test then gets a home of its own inside the
session.
"""

from __future__ import annotations

import _isolation

# First, before anything else is imported: the session environment and the guard.
_isolation.isolate_session()

import pytest  # noqa: E402 - deliberately after the isolation


@pytest.fixture(autouse=True)
def isolate_bugpilot_config(monkeypatch):
    """A home of its own for each test, inside the session: `~`, `Path.home()` and a child's home.

    Returns the test's (empty, existing) user configuration folder, named by
    ``BUGPILOT_CONFIG_DIR`` as before. It sits beside the home, so the home's
    own ``.bugpilot`` stays absent unless a test creates it.
    """
    from pathlib import Path

    home = _isolation.new_test_home()
    for name, value in home.items():
        monkeypatch.setenv(name, value)
    config_dir = Path(home["HOME"]).parent / (Path(home["HOME"]).name + "-config")
    config_dir.mkdir()
    monkeypatch.setenv("BUGPILOT_CONFIG_DIR", str(config_dir))
    return config_dir


@pytest.fixture(autouse=True)
def isolation_guard():
    """Fail a test whose code reached for real BugPilot data, even if that code swallowed the refusal.

    The guard raises before the operation; product code that catches broadly
    could still carry on. Every refusal is recorded, in this process and in its
    Python children (their log), and is reported here — once: a refusal this
    check reports is not reported again by the session-wide check below.
    """
    marker = _isolation.violation_marker()
    logged = len(_isolation.guard_log_lines())
    yield
    refused = _isolation.collect_since(marker, logged)
    if refused:
        pytest.fail(
            "The test isolation guard refused access to real BugPilot data:\n  " + "\n  ".join(refused),
            pytrace=False,
        )


_OUTSIDE_A_TEST = (
    "The test isolation guard refused access to real BugPilot data outside any single test "
    "(at collection, in a module- or session-scoped fixture, or in a teardown), and the code "
    "carried on:\n  "
)


@pytest.fixture(scope="session", autouse=True)
def isolation_guard_session():
    """Fail the run on a refusal no test's own check saw, even if the code swallowed it.

    An autouse session fixture: set up before every module-scoped fixture and
    every session-scoped one a test requests, and torn down after them, so it
    sees collection-time code, those fixtures and their teardowns. Its error is
    attached to the last test's teardown; the message says it belongs to no
    single test.
    """
    yield
    refused = _isolation.collect_unreported()
    if refused:
        pytest.fail(_OUTSIDE_A_TEST + "\n  ".join(refused), pytrace=False)


def pytest_sessionfinish(session, exitstatus):
    """The backstop for a run where the session check never ran (no test ran) or came too late."""
    refused = _isolation.collect_unreported()
    if refused:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        writer = session.config.get_terminal_writer()
        writer.line()
        writer.line("ERROR test isolation - " + _OUTSIDE_A_TEST + "\n  ".join(refused), red=True)


@pytest.fixture(autouse=True)
def no_real_jira(monkeypatch):
    """No test talks to anybody's Jira.

    ``load_config`` falls back to ``JIRA_BASE_URL`` / ``JIRA_EMAIL`` /
    ``JIRA_TOKEN`` from the environment, which a developer who uses this tool
    has set — so the suite was quietly issuing HTTP requests to a real tenant
    and passing because the example key happened to be a real ticket there.
    Renaming the example to a project that does not exist is what surfaced it.

    Without credentials every fetch takes the ``missing_env`` path and returns
    the mock issue, which is what these tests mean by "a fetch". A test that
    wants credentials sets them itself; monkeypatch ordering lets it.
    """
    for name in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def execution_trace(caplog):
    """The `bugpilot.execution` trace, captured despite its propagate=False.

    The logger deliberately does not propagate (a host's root handler must not
    receive the trace — see logging_utils), so caplog's root-level capture
    never sees it; the handler is attached to the logger itself instead.
    """
    import logging

    logger = logging.getLogger("bugpilot.execution")
    caplog.set_level(logging.INFO, logger="bugpilot.execution")
    logger.addHandler(caplog.handler)
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)
