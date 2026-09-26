# Contributing

This repository is a local QA runtime. Cursor plans, Stagehand discovers, Playwright executes, and MCP coordinates. The design source of truth is [autonomous-qa-project-design-spec.md](autonomous-qa-project-design-spec.md). Do not rewrite that spec while implementing an issue.

## Issue status

Work is tracked on the [autonomous-qa](https://github.com/users/srmlcn/projects/10) project (owner `srmlcn`, project number `10`). The board columns are the `Status` field. Set `Status` on the issue you are implementing in the same turn as the action. Opening a pull request does not move the card.

Use these option names exactly:

| Status | When to set it |
| --- | --- |
| `Backlog` | Not started, or blocked. |
| `Ready` | Unblocked and not started. Set this when your change unblocks a child issue. |
| `In progress` | You have started implementation. Set this before the first code change. |
| `In review` | The pull request is open. Set this when you open the pull request. |
| `Done` | The pull request is merged and the issue acceptance criteria are met. |

Rules:

- Track the issue. Do not add the pull request as a second card. The issue's linked pull requests field is what the board shows.
- If an update fails because the issue is not on the project, add the issue first, then set `Status`. A newly added item lands in `Backlog`, so the status write is still required.
- Leave `Done` unset while the pull request is open.
- If you stop without a pull request, set `Ready` when the issue is still actionable, or `Backlog` when it is blocked.
- Update the leaf you are implementing. Set its parent track to `In progress` when you start the first child, and set that track to `Done` only when every child is `Done`. Apply the same rule from tracks to epics. Do not mark the roadmap issue done while any child is open.

Agents using the GitHub MCP server should call `projects_write`:

```json
{
  "method": "update_project_item",
  "owner": "srmlcn",
  "owner_type": "user",
  "project_number": 10,
  "item_owner": "srmlcn",
  "item_repo": "qa-agent",
  "issue_number": 0,
  "updated_field": { "name": "Status", "value": "In progress" }
}
```

Replace `issue_number` and `value`. To add a missing issue, call `add_project_item` with `item_type` `issue`, the same owner, repository, and issue number, then set `Status`.

## Code quality

Strive for quality and clean code design patterns. A change that passes tests and is hard to follow is not done.

- One module, one reason to change. Stay inside the directory boundaries in spec section 9.
- Depend inward. Schemas, result types, and errors do not import Playwright, Stagehand, or process I/O.
- Validate external input at the boundary. Model actions, steps, and results as discriminated unions.
- Hide vendor SDKs behind a small adapter. FlowSpec and replay stay provider-independent.
- Register CLI commands and MCP tools from the filesystem once that registry exists, instead of a hand-maintained switch.
- Put effects at the edge. Keep the logic in between pure and small.
- Redact secrets before writing logs, artifacts, or returned payloads.
- Do not introduce `any`, unchecked casts, or a second implementation of an existing helper.
- Do not widen a schema or error contract silently.
- Lock behavior with unit tests under `tests/unit/<module>/` in the same change.
- Names, types, and file layout should make the diff obvious in review.

## Working agreements

- One leaf issue, one pull request. Edit only the paths that issue owns.
- Conventional Commits: `type(scope): imperative subject`, lowercase, subject 50 characters or fewer. Use `feat` for a minor bump, `fix` for a patch, and a `BREAKING CHANGE` footer for a major bump.
- Run the repository test, typecheck, and lint scripts before opening the pull request once those scripts exist.
