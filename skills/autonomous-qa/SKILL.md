---
name: autonomous-qa
description: Run local QA through the autonomous-qa MCP tools. Use when discovering a UI flow, replaying a saved flow, repairing a stale locator, capturing an auth profile, or checking QA runtime health.
---

# autonomous-qa

Cursor plans. Stagehand discovers. Playwright executes. The MCP server coordinates.

## Tools

- `qa.status` reports install and project health. It does not launch a browser.
- `qa.discover_flow` explores an unknown UI once and writes a FlowSpec. This calls the LLM.
- `qa.execute_flow` and `qa.execute_suite` replay saved flows. They do not call the LLM.
- `qa.repair_flow` repairs a locator failure only. Assertion failures are not repaired.
- `qa.capture_auth` captures a headed auth profile under `~/.autonomous-qa/auth`.
- `qa.list_flows` lists flow metadata.
- `qa.get_run` and `qa.cancel_run` read or cancel a run.

## Repositories

Global settings in `~/.autonomous-qa/config.json` apply in every repo. The API key stays in the environment named by `llm.apiKeyEnv`, or in `~/.autonomous-qa/env`. Do not write the key into the repo, a flow, or tool arguments.

A repo does not need `.cursor` or `.autonomous-qa`. Browser tools use the global settings and built-in localhost defaults. Flows and run artifacts then go to `~/.autonomous-qa/projects/<project-id>/`.

When a repo needs a local override, add `.autonomous-qa/config.yml`. A key in that file replaces the same global key. A key the file omits stays global. `allowedHosts`, `productionAllowed`, and `security` have no global scope. They stay at the built-in defaults unless the repo file sets them. If `.autonomous-qa` already exists, flows and artifacts stay in the repo.

`autonomous-qa init` creates that override directory, gitignore entries, and an optional project MCP server with `--install-mcp`. Do not run it before ordinary browser tools.

When several workspace roots are open and none contain `.autonomous-qa`, pass `projectRoot`. When exactly one root contains `.autonomous-qa`, that root is selected.

A project `.cursor/mcp.json` server named `autonomous-qa` overrides the user-level server.
