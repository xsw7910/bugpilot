"""A Git History corpus: does Git History v2 find the right commits and files?

Not a test module (no `test_` prefix, so pytest does not collect it); the
assertions over it are in `test_git_history_corpus.py`. Run it directly for the
table: `python tests/git_history_corpus.py`.

One synthetic repository, written with `git fast-import` so every run builds the
same history byte for byte: background churn, a generic word in many messages,
a feature branch and its merge, a merge that resolved a conflict, an import and
a reformat, a rename, a documentation-only change, hot files with deep history.
Each case is a query against it with the commits and supporting files a
developer would want, and the metrics are deliberately plain — ranks, recall,
precision, noise — so a change in any of them can be read off the table.

Every identifier is synthetic: `JR-` keys, invented paths, invented messages.
"""

from __future__ import annotations

import subprocess
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

from bugpilot.core import git_history
from bugpilot.core.git_history import GitHistoryQuery, collect_git_history
from bugpilot.core.models import GitHistoryOptions

TOP_N = 5
DAY = 86_400
START = 1_672_531_200  # 2023-01-01T00:00:00Z


# --- the history -------------------------------------------------------------------------


class History:
    """A fast-import stream, and the tree of every branch it has written."""

    def __init__(self) -> None:
        self.stream: list[bytes] = []
        self.marks: dict[str, int] = {}
        self.trees: dict[str, dict[str, str]] = {"master": {}}
        #: Each branch's tree when it left master: what its merge brings is what changed since.
        self.bases: dict[str, dict[str, str]] = {}
        self.tips: dict[str, str | None] = {"master": None}
        self.day = 0

    def _data(self, text: str) -> None:
        raw = text.encode("utf-8")
        self.stream.append(f"data {len(raw)}\n".encode() + raw + b"\n")

    def commit(
        self,
        label: str,
        message: str,
        changes: dict[str, str | None] | None = None,
        *,
        branch: str = "master",
        renames: tuple[tuple[str, str], ...] = (),
        merge: str | None = None,
        days: int = 3,
    ) -> str:
        """Write one commit; ``None`` content deletes. Labels name commits for the cases."""
        self.day += days
        mark = len(self.marks) + 1
        self.marks[label] = mark
        tree = self.trees.setdefault(branch, dict(self.trees["master"]))
        self.stream.append(f"commit refs/heads/{branch}\nmark :{mark}\n".encode())
        self.stream.append(f"committer Dev <dev@example.com> {START + self.day * DAY} +0000\n".encode())
        self._data(message)
        tip = self.tips.get(branch)
        if tip is not None:
            self.stream.append(f"from :{self.marks[tip]}\n".encode())
        if merge is not None:
            self.stream.append(f"merge :{self.marks[self.tips[merge]]}\n".encode())
        for old, new in renames:
            self.stream.append(f"R {old} {new}\n".encode())
            tree[new] = tree.pop(old)
        for path, text in (changes or {}).items():
            if text is None:
                self.stream.append(f"D {path}\n".encode())
                tree.pop(path, None)
            else:
                self.stream.append(f"M 100644 inline {path}\n".encode())
                self._data(text)
                tree[path] = text
        self.stream.append(b"\n")
        self.tips[branch] = label
        return label

    def branch(self, name: str) -> None:
        """A branch from master's tip, with master's tree."""
        self.trees[name] = dict(self.trees["master"])
        self.bases[name] = dict(self.trees["master"])
        self.tips[name] = self.tips["master"]

    def merge(self, label: str, message: str, branch: str, extra: dict[str, str] | None = None) -> str:
        """Merge ``branch`` into master: its changes, plus ``extra`` (a resolution of the merge's own)."""
        base = self.bases[branch]
        brought = {path: text for path, text in self.trees[branch].items() if base.get(path) != text}
        return self.commit(label, message, {**brought, **(extra or {})}, merge=branch)


def _v(path: str, version: int) -> str:
    return f"// {path}\nint version = {version};\n"


#: Background churn: (message, files). Cycled to fill the years between scenario commits.
_CHURN = (
    ("Tidy logging", ("src/util/Log.cpp",)),
    ("Update template defaults", ("src/ui/TemplateStore.cpp",)),
    ("Refactor helpers", ("src/util/Strings.cpp",)),
    ("Volume handling cleanup", ("src/volume/VolumeIO.cpp",)),
    ("Template list refresh", ("src/ui/TemplateStore.cpp", "src/util/Strings.cpp")),
    ("Fix typo in comments", ("src/util/Log.cpp",)),
    ("Volume metadata update", ("src/volume/VolumeIO.cpp", "src/util/Log.cpp")),
    ("Template cache warmup", ("src/ui/TemplateStore.cpp",)),
    ("Speed up volume load", ("src/volume/VolumeIO.cpp",)),
    ("Template persistence tweak", ("src/ui/TemplateStore.cpp", "src/util/Log.cpp")),
)


def build_history() -> History:
    """The corpus history, oldest first; each scenario commit carries a label the cases name."""
    h = History()
    churn_index = [0]

    def churn(count: int) -> None:
        for _ in range(count):
            message, files = _CHURN[churn_index[0] % len(_CHURN)]
            churn_index[0] += 1
            h.commit(f"bg-{churn_index[0]}", message, {path: _v(path, churn_index[0]) for path in files})

    base = [
        "src/blend/AngleBlend.cpp", "src/blend/AngleRange.cpp", "src/blend/BlendMerge.cpp",
        "src/blend/BucketSort.cpp", "src/volume/VolumeSelector.cpp", "src/volume/VolumeCache.cpp",
        "src/volume/Interp.cpp", "src/volume/VolumeClip.cpp", "src/render/Renderer.cpp",
        "src/render/ShaderCache.cpp", "src/io/TiffReader.cpp", "src/io/TraceBuffer.cpp",
        "src/io/OldReader.cpp", "src/io/TraceIndex.cpp", "src/io/IndexWriter.cpp", "src/ui/ExportDialog.cpp",
        "src/ui/TemplateDialog.cpp", "src/ui/TemplateStore.cpp", "src/ui/AboutBox.cpp", "src/util/Log.cpp",
        "src/util/Strings.cpp", "src/volume/VolumeIO.cpp", "docs/export.md",
        "third_party/zlib/zlib.c", "src/generated/Version.cpp",
    ]
    imported = {path: _v(path, 0) for path in base}
    imported.update({f"src/legacy/import/f{i:03d}.cpp": _v(f"f{i}", 0) for i in range(230)})
    h.commit("import", "Initial import", imported)
    churn(4)

    # 7. old but highly relevant, then recent weak commits on the same file (8).
    h.commit("s7-old", "JR-107: fix BucketSort for split buckets",
             {"src/blend/BucketSort.cpp": _v("gs", 1), "src/blend/BucketKey.cpp": _v("gk", 1)})
    churn(6)

    # 19. a hot pair of files; the commit that matters is deep in both histories.
    h.commit("s19-deep", "Switch index offsets to 64-bit",
             {"src/io/TraceIndex.cpp": _v("ti", 1), "src/io/IndexWriter.cpp": _v("iw", 1)})
    # Twelve newer commits on each file alone: the deep one is thirteenth in both.
    for i in range(12):
        h.commit(f"s19-hot-index-{i}", "Trace index maintenance", {"src/io/TraceIndex.cpp": _v("ti", 10 + i)}, days=1)
        h.commit(f"s19-hot-writer-{i}", "Index writer maintenance", {"src/io/IndexWriter.cpp": _v("iw", 10 + i)}, days=1)
    churn(5)

    # 13. a rename inside a relevant commit.
    h.commit("s13-rename", "JR-113: move the legacy reader into io",
             {"src/io/TiffReader.cpp": _v("sr", 1)}, renames=(("src/io/OldReader.cpp", "src/io/LegacyReader.cpp"),))
    churn(4)

    # 1/11/15. a feature branch, two commits, merged with --no-ff.
    h.branch("feature/JR-101")
    h.commit("s1-feature-a", "JR-101: clamp the angle range in AngleBlend",
             {"src/blend/AngleBlend.cpp": _v("as", 1), "src/blend/AngleRange.cpp": _v("ar", 1)}, branch="feature/JR-101")
    h.commit("s1-feature-b", "JR-101: angle range tests",
             {"tests/AngleRangeTest.cpp": _v("art", 1)}, branch="feature/JR-101")
    churn(1)
    h.merge("s1-merge", "Merge branch 'feature/JR-101-angle-range'", "feature/JR-101")
    churn(3)

    # 11b. a merge that resolved a conflict: changes of its own.
    h.branch("feature/JR-111")
    h.commit("s11-feature", "JR-111: shader variant selection",
             {"src/render/Renderer.cpp": _v("r-branch", 1)}, branch="feature/JR-111")
    h.commit("s11-master", "Renderer frame pacing", {"src/render/Renderer.cpp": _v("r-master", 1)})
    h.merge("s11-merge", "Merge branch 'feature/JR-111-shader'",
            "feature/JR-111", extra={"src/render/Renderer.cpp": _v("r-resolved", 1), "src/render/ShaderVariant.cpp": _v("sv", 1)})
    churn(3)

    # 2. a shared keyword.
    h.commit("s2-keyword", "Fix postblend volume selection",
             {"src/volume/VolumeSelector.cpp": _v("vs", 1), "src/volume/PostblendFilter.cpp": _v("pf", 1)})
    churn(2)
    # 3. an Additional Commit Keyword.
    h.commit("s3-gitkw", "Rework the blendmerge pass",
             {"src/blend/BlendMerge.cpp": _v("sm", 1), "src/blend/MergePlan.cpp": _v("mp", 1)})
    churn(2)
    # 4. a Focus File, and the commit that matters on it.
    h.commit("s4-focus", "Handle short traces in TraceBuffer",
             {"src/io/TiffReader.cpp": _v("sr", 2), "src/io/TraceBuffer.cpp": _v("tb", 1)})
    h.commit("s4-other", "TIFF header logging", {"src/io/TiffReader.cpp": _v("sr", 3)})
    churn(2)
    # 5. an Additional File.
    h.commit("s5-additional", "Fix export filename quoting",
             {"src/ui/ExportDialog.cpp": _v("ed", 1), "src/ui/ExportPath.cpp": _v("ep", 1)})
    churn(2)
    # 6. a generic keyword, and file-history evidence it must not bury.
    h.commit("s6-target", "JR-106: reject duplicate template names",
             {"src/ui/TemplateDialog.cpp": _v("td", 1), "src/ui/TemplateNames.cpp": _v("tn", 1)})
    churn(3)
    h.commit("s6-dialog-fix", "Fix dialog crash on an empty list", {"src/ui/TemplateDialog.cpp": _v("td", 2)})
    churn(4)
    # 9. a regression: an identifier the report names, introduced in a speed-up.
    h.commit("s9-regression", "Add InterpCache to speed up interpolation",
             {"src/volume/Interp.cpp": _v("in", 1), "src/volume/InterpCache.cpp": _v("ic", 1)})
    churn(2)
    # 10. an unrelated message, co-changing a relevant file.
    h.commit("s10-cochange", "Misc cleanup",
             {"src/volume/VolumeSelector.cpp": _v("vs", 2), "src/volume/VolumeCache.cpp": _v("vc", 1)})
    churn(2)
    # 14. a documentation-only change, and the implementation beside it.
    h.commit("s14-docs", "JR-114: document the export header", {"docs/export.md": _v("doc", 1)})
    h.commit("s14-code", "JR-114: write the export header",
             {"src/ui/ExportDialog.cpp": _v("ed", 2), "src/ui/ExportHeader.cpp": _v("eh", 1)})
    churn(2)
    # 16. one supporting file changed by two related commits.
    h.commit("s16-a", "JR-116: speed up shader warmup",
             {"src/render/Renderer.cpp": _v("r", 2), "src/render/ShaderCache.cpp": _v("sc", 1)})
    h.commit("s16-b", "JR-116: warm shaders in the background",
             {"src/render/Renderer.cpp": _v("r", 3), "src/render/ShaderCache.cpp": _v("sc", 2)})
    churn(2)
    # 17. a noisy repository term, and the commits that matter on its file.
    h.commit("s17-clip", "JR-117: fix volume clipping at the edges", {"src/volume/VolumeClip.cpp": _v("vcl", 1)})
    h.commit("s17-planes", "Clamp clip planes", {"src/volume/VolumeClip.cpp": _v("vcl", 2)})
    churn(4)
    # 12. a reformat touching everything, naming the shared keyword.
    h.commit("s12-bulk", "Reformat sources (postblend, angle range, clipping)",
             {f"src/legacy/import/f{i:03d}.cpp": _v(f"f{i}", 1) for i in range(230)}
             | {"src/volume/VolumeSelector.cpp": _v("vs", 3)})
    # 8. recent weak commits on the old relevant file.
    for i in range(6):
        h.commit(f"s8-weak-{i}", "Refactor sorting helpers",
                 {"src/blend/BucketSort.cpp": _v("gs", 10 + i), f"src/util/Sort{i}.cpp": _v("so", i)}, days=2)
    churn(3)
    return h


def build_repository(root: Path, history: History | None = None) -> dict[str, str]:
    """Write ``history`` (the corpus by default) as a repository at ``root``; returns label -> commit hash."""
    root.mkdir(parents=True, exist_ok=True)
    history = history or build_history()

    def run(*args: str, **kwargs) -> None:
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, **kwargs)

    run("init", "-q")
    run("config", "user.email", "dev@example.com")
    run("config", "user.name", "Dev")
    run("config", "core.autocrlf", "false")
    marks = root / ".git" / "corpus-marks"
    run("fast-import", "--quiet", f"--export-marks={marks}", input=b"".join(history.stream) + b"done\n")
    run("checkout", "-q", "-f", "master")
    by_mark: dict[int, str] = {}
    for line in marks.read_text(encoding="utf-8").splitlines():
        mark, commit = line.split()
        by_mark[int(mark.lstrip(":"))] = commit
    return {label: by_mark[mark] for label, mark in history.marks.items()}


# --- the cases ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class GitHistoryCase:
    """One query, and what a developer would want back from it."""

    name: str
    kind: str
    query: GitHistoryQuery
    expected_commits: tuple[str, ...]
    expected_supporting: tuple[str, ...] = ()
    #: Labels that are wrong answers on sight (beyond background churn, which always is).
    noise_commits: tuple[str, ...] = ()
    #: A merge wrapper that only repeats an expected commit.
    duplicates: tuple[str, ...] = ()
    settings: GitHistoryOptions = field(default_factory=GitHistoryOptions)


def _q(**kwargs) -> GitHistoryQuery:
    known = kwargs.pop("known", None)
    ranked = kwargs.get("ranked_files", ())
    return GitHistoryQuery(**kwargs, known_files=tuple(known if known is not None else ranked))


CASES: tuple[GitHistoryCase, ...] = (
    GitHistoryCase("issue-id", "issue_id", _q(issue_id="JR-101", ranked_files=("src/blend/AngleBlend.cpp",)),
                   ("s1-feature-a", "s1-feature-b"), ("src/blend/AngleRange.cpp", "tests/AngleRangeTest.cpp"),
                   duplicates=("s1-merge",)),
    GitHistoryCase("shared-keyword", "shared_keyword",
                   _q(shared_keywords=("postblend",), ranked_files=("src/volume/VolumeSelector.cpp",)),
                   ("s2-keyword",), ("src/volume/PostblendFilter.cpp",), noise_commits=("s12-bulk",)),
    GitHistoryCase("commit-keyword", "additional_commit_keyword",
                   _q(git_keywords=("blendmerge",), ranked_files=("src/blend/AngleBlend.cpp",)),
                   ("s3-gitkw",), ("src/blend/BlendMerge.cpp", "src/blend/MergePlan.cpp")),
    GitHistoryCase("focus-file", "focus_file",
                   _q(focus_files=("src/io/TiffReader.cpp",), extracted_terms=("TraceBuffer",)),
                   ("s4-focus",), ("src/io/TraceBuffer.cpp",)),
    GitHistoryCase("additional-file", "additional_file",
                   _q(git_files=("src/ui/ExportDialog.cpp",), ranked_files=("src/render/Renderer.cpp",)),
                   ("s5-additional", "s14-code"), ("src/ui/ExportPath.cpp", "src/ui/ExportHeader.cpp")),
    GitHistoryCase("generic-keyword", "generic_keyword",
                   _q(shared_keywords=("template",), ranked_files=("src/ui/TemplateDialog.cpp",)),
                   ("s6-target", "s6-dialog-fix"), ("src/ui/TemplateNames.cpp",)),
    GitHistoryCase("old-relevant", "old_relevant", _q(issue_id="JR-107", ranked_files=("src/blend/BucketSort.cpp",)),
                   ("s7-old",), ("src/blend/BucketKey.cpp",),
                   noise_commits=tuple(f"s8-weak-{i}" for i in range(6))),
    GitHistoryCase("recent-weak", "recent_weak",
                   _q(extracted_terms=("BucketSort",), ranked_files=("src/blend/BucketSort.cpp",)),
                   ("s7-old",), ("src/blend/BucketKey.cpp",), noise_commits=tuple(f"s8-weak-{i}" for i in range(6))),
    GitHistoryCase("regression", "regression",
                   _q(extracted_terms=("InterpCache",), ranked_files=("src/volume/Interp.cpp",)),
                   ("s9-regression",), ("src/volume/InterpCache.cpp",)),
    GitHistoryCase("co-change", "co_change", _q(ranked_files=("src/volume/VolumeSelector.cpp",)),
                   ("s10-cochange", "s2-keyword"), ("src/volume/VolumeCache.cpp",), noise_commits=("s12-bulk",)),
    GitHistoryCase("conflict-merge", "merge", _q(issue_id="JR-111", ranked_files=("src/render/Renderer.cpp",)),
                   ("s11-feature", "s11-merge"), ("src/render/ShaderVariant.cpp",)),
    GitHistoryCase("bulk", "bulk", _q(shared_keywords=("clipping",), ranked_files=("src/volume/VolumeClip.cpp",)),
                   ("s17-clip", "s17-planes"), (), noise_commits=("s12-bulk",)),
    GitHistoryCase("rename", "rename", _q(issue_id="JR-113", ranked_files=("src/io/TiffReader.cpp",)),
                   ("s13-rename",), ("src/io/LegacyReader.cpp",)),
    GitHistoryCase("docs-only", "documentation", _q(issue_id="JR-114", ranked_files=("src/ui/ExportDialog.cpp",)),
                   ("s14-code", "s14-docs"), ("src/ui/ExportHeader.cpp",)),
    GitHistoryCase("manual-no-id", "manual", _q(shared_keywords=("angle range",), ranked_files=("src/blend/AngleBlend.cpp",)),
                   ("s1-feature-a", "s1-feature-b"), ("src/blend/AngleRange.cpp", "tests/AngleRangeTest.cpp"),
                   noise_commits=("s12-bulk",), duplicates=("s1-merge",)),
    GitHistoryCase("shared-supporting", "multiple_commits", _q(issue_id="JR-116", ranked_files=("src/render/Renderer.cpp",)),
                   ("s16-a", "s16-b"), ("src/render/ShaderCache.cpp",)),
    GitHistoryCase("noisy-term", "noisy_term", _q(shared_keywords=("volume",), ranked_files=("src/volume/VolumeClip.cpp",)),
                   ("s17-clip", "s17-planes"), ()),
    GitHistoryCase("no-match", "no_match", _q(shared_keywords=("hologram",), ranked_files=("src/ui/AboutBox.cpp",)), (), ()),
    GitHistoryCase("deep-history", "history_depth",
                   _q(focus_files=("src/io/TraceIndex.cpp",), ranked_files=("src/io/IndexWriter.cpp",)),
                   ("s19-deep",), ()),
)


# --- running and measuring -------------------------------------------------------------------------


@dataclass
class CaseResult:
    case: GitHistoryCase
    retained: list[str]
    supporting: list[str]
    candidate_count: int
    git_commands: int
    elapsed_s: float
    #: Each retained commit's score and reasons, for the explainability check.
    explained: list[tuple[str, int, tuple[str, ...]]] = field(default_factory=list)

    def rank(self, label: str) -> int | None:
        return self.retained.index(label) + 1 if label in self.retained else None

    @property
    def commit_recall(self) -> float:
        expected = self.case.expected_commits
        return 1.0 if not expected else sum(label in self.retained for label in expected) / len(expected)

    @property
    def top_recall(self) -> float:
        expected = self.case.expected_commits
        top = self.retained[:TOP_N]
        return 1.0 if not expected else sum(label in top for label in expected) / len(expected)

    @property
    def top_precision(self) -> float:
        top = self.retained[:TOP_N]
        if not top:
            return 1.0 if not self.case.expected_commits else 0.0
        return sum(label in self.case.expected_commits for label in top) / len(top)

    @property
    def first_correct(self) -> int | None:
        ranks = [self.rank(label) for label in self.case.expected_commits]
        found = [rank for rank in ranks if rank is not None]
        return min(found) if found else None

    @property
    def noise(self) -> int:
        """Obvious wrong answers retained: background churn and the case's named noise."""
        return sum(label.startswith("bg-") or label in self.case.noise_commits for label in self.retained)

    @property
    def duplicates(self) -> int:
        return sum(label in self.case.duplicates for label in self.retained)

    @property
    def supporting_recall(self) -> float:
        expected = self.case.expected_supporting
        return 1.0 if not expected else sum(path in self.supporting for path in expected) / len(expected)

    @property
    def supporting_precision(self) -> float:
        if not self.supporting:
            return 1.0
        return sum(path in self.case.expected_supporting for path in self.supporting) / len(self.supporting)

    @property
    def supporting_noise(self) -> int:
        return sum(path not in self.case.expected_supporting for path in self.supporting)


class _Counter:
    """Counts the git processes a search starts.

    Every one goes through ``subprocess.Popen`` — ``run_command`` by way of
    ``subprocess.run`` — so that is the one door counted.
    """

    def __init__(self) -> None:
        self.count = 0

    def __enter__(self):
        self._popen = subprocess.Popen
        counter = self

        class Popen(self._popen):  # type: ignore[misc, valid-type]
            def __init__(self, args, *rest, **kwargs):
                if args and args[0] == "git":
                    counter.count += 1
                super().__init__(args, *rest, **kwargs)

        subprocess.Popen = Popen
        return self

    def __exit__(self, *exc):
        subprocess.Popen = self._popen


def run_case(case: GitHistoryCase, root: Path, hashes: dict[str, str], settings: GitHistoryOptions | None = None) -> CaseResult:
    labels = {commit: label for label, commit in hashes.items()}
    with _Counter() as counter:
        started = time.monotonic()
        record = collect_git_history(root, "JR-0", case.query, settings or case.settings).record
        elapsed = time.monotonic() - started
    return CaseResult(
        case=case,
        retained=[labels.get(commit.hash, commit.hash[:10]) for commit in record.commits],
        supporting=[item.path for item in record.supporting_files],
        candidate_count=record.candidate_count,
        git_commands=counter.count,
        elapsed_s=elapsed,
        explained=[(labels.get(c.hash, c.hash[:10]), c.score, c.reasons) for c in record.commits],
    )


def run_corpus(root: Path, hashes: dict[str, str], settings: GitHistoryOptions | None = None) -> list[CaseResult]:
    return [run_case(case, root, hashes, settings) for case in CASES]


def summarise(results: list[CaseResult]) -> dict[str, float]:
    n = len(results)
    with_commits = [r for r in results if r.case.expected_commits]
    with_files = [r for r in results if r.case.expected_supporting]
    return {
        "cases": n,
        "commit_recall": round(sum(r.commit_recall for r in with_commits) / len(with_commits), 3),
        "top5_recall": round(sum(r.top_recall for r in with_commits) / len(with_commits), 3),
        "top5_precision": round(sum(r.top_precision for r in results) / n, 3),
        "first_correct_at_1": sum(r.first_correct == 1 for r in with_commits),
        "noise_commits": sum(r.noise for r in results),
        "duplicate_merges": sum(r.duplicates for r in results),
        "supporting_recall": round(sum(r.supporting_recall for r in with_files) / len(with_files), 3),
        "supporting_precision": round(sum(r.supporting_precision for r in results) / n, 3),
        "supporting_noise": sum(r.supporting_noise for r in results),
        "git_commands": sum(r.git_commands for r in results),
    }


def report(results: list[CaseResult], title: str = "") -> str:
    lines = [title] if title else []
    lines.append(f"{'case':18} {'rec':>4} {'top5':>4} {'p@5':>4} {'1st':>3} {'noise':>5} {'dup':>3} {'srec':>4} {'sprec':>5} {'snoise':>6} {'cand':>4} {'kept':>4} {'git':>3} {'ms':>5}")
    for r in results:
        lines.append(
            f"{r.case.name:18} {r.commit_recall:4.2f} {r.top_recall:4.2f} {r.top_precision:4.2f} "
            f"{r.first_correct if r.first_correct is not None else '-':>3} {r.noise:5d} {r.duplicates:3d} "
            f"{r.supporting_recall:4.2f} {r.supporting_precision:5.2f} {r.supporting_noise:6d} "
            f"{r.candidate_count:4d} {len(r.retained):4d} {r.git_commands:3d} {r.elapsed_s * 1000:5.0f}"
        )
    lines.append("summary: " + ", ".join(f"{k}={v}" for k, v in summarise(results).items()))
    return "\n".join(lines)


class batch4_behaviour:
    """Run as Batch 4 did: no merge collapsing, no broad terms. For before/after tables."""

    def __enter__(self):
        self._collapse, self._broad = git_history._collapse_merge_wrappers, git_history._separate_broad_terms
        git_history._collapse_merge_wrappers = lambda repo_root, ranked, window, failures: ranked
        git_history._separate_broad_terms = lambda candidates: None
        return self

    def __exit__(self, *exc):
        git_history._collapse_merge_wrappers, git_history._separate_broad_terms = self._collapse, self._broad


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if "--baseline" in args:
        with batch4_behaviour():
            return _main(args)
    return _main(args)


def _main(args: list[str]) -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "corpus"
        hashes = build_repository(root)
        results = run_corpus(root, hashes)
        print(report(results, "Git History corpus — Recent"))
        if "--detail" in args:
            for r in results:
                print(f"\n{r.case.name}: retained {r.retained}\n  supporting {r.supporting}")
        if "--broader" in args:
            print()
            print(report(run_corpus(root, hashes, GitHistoryOptions(history_depth="broader")), "Git History corpus — Broader"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
