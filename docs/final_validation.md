# Final Validation

Run from the target repository root after installing bugpilot:

```powershell
python -m pip install -e .
python -m pytest
python -m bugpilot bug JR-12345
python -m bugpilot status JR-12345
python -m bugpilot summarize-results JR-12345
python -m bugpilot memory update JR-12345
python -m bugpilot review-package JR-12345
python -m bugpilot delivery-check JR-12345
python -m bugpilot commit-plan JR-12345
python -m bugpilot push-plan JR-12345
python -m bugpilot clean JR-12345
python -m bugpilot status JR-12345
python -m bugpilot bug JR-12345
python -m bugpilot status JR-12345
python -m bugpilot bug JR-12345 --resume
python -m bugpilot clean JR-12345 --include-memory
python -m bugpilot bug JR-12345 --include-memory
python -m bugpilot bug JR-12345 --allow-mock
python -m bugpilot clean JR-12345
python -m bugpilot bug JR-12345 --fresh --no-mock
python -m bugpilot fetch JR-12345 --allow-mock
python -m bugpilot fetch JR-12345
```

Expected outcomes:

- Tests pass.
- `.ai/JR-12345/` is generated.
- `.ai_memory/bugs/JR-12345.md` is generated or updated.
- `result_summary.md`, `manual_validation.md`, and `final_review_prompt.md` can be generated.
- `commit_plan.md` and `push_plan.md` can be generated.
- `clean` removes only `.ai/JR-12345/`.
- The default `bug` command creates a clean `.ai/JR-12345/` run output.
- `--resume` preserves existing `.ai/JR-12345/` artifacts.
- Memory is preserved unless `--include-memory` is provided.
- Default real Jira mode fails clearly when Jira fetch fails.
- `--allow-mock` works without Jira env vars by using clearly marked mock fallback.
- No automatic agent invocation occurs.
- No automatic Jira write, commit, push, merge, or PR creation occurs.
