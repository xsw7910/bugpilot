# Final Workflow Checklist

Use this checklist before and after a real end-to-end bugpilot workflow.

## A. Before Running

- [ ] You are in the target product repo root.
- [ ] `bugpilot doctor` passes or any warnings are understood.
- [ ] Jira environment variables are present.
- [ ] Working tree state is understood.
- [ ] Issue key is confirmed.

## B. After `bugpilot bug`

- [ ] `jira_summary.md` shows `Data Source` as `jira`.
- [ ] `Mock/demo Jira data` is `no`.
- [ ] `jira_summary.md` is readable.
- [ ] `jira_parsed.md` is useful.
- [ ] `code_search.md` references product code.
- [ ] `search_quality.json` has been reviewed.

## C. Before the agent

- [ ] Current branch is not `main` or `master`.
- [ ] `agent_task.md` has been reviewed.
- [ ] `agent_team_instructions.md` has been reviewed.
- [ ] Search confidence is understood.
- [ ] Optional agent commit/push will require explicit approval.
- [ ] The agent must not commit `.ai/` or `.ai_memory/`.
- [ ] The agent must not push `main`/`master` or force push.

## C2. Retry Or Manual Fix

- [ ] If retrying the agent, `user_feedback.md` describes what failed or needs correction.
- [ ] If retrying the agent, `agent_retry_prompt.md` has been generated and reviewed.
- [ ] If the developer fixed the issue manually, `manual-result` templates have been filled in.
- [ ] Existing result files were not overwritten unless `--overwrite` was intentional.

## D. Before `jira-comment --execute`

- [ ] `jira_comment_draft.md` has been reviewed.
- [ ] Draft contains no secrets or tokens.
- [ ] Draft contains no false test claims.
- [ ] Draft contains no attachment-content claims.
- [ ] Draft contains no private local paths if those should not be shared.
- [ ] Preview command has been run:

```powershell
bugpilot jira-comment JR-23110
```

## E. After `jira-comment --execute`

- [ ] Only one comment was added.
- [ ] Jira status did not change.
- [ ] Jira fields did not change.
- [ ] Jira assignee did not change.
- [ ] Result artifacts were saved:

```text
.ai/JR-23110/jira_comment_post_result.json
.ai/JR-23110/jira_comment_post_summary.md
```
