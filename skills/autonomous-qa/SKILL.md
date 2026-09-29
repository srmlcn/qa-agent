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

User LLM settings live in `~/.autonomous-qa/config.json`. The API key stays in the environment named by `llm.apiKeyEnv`, or in `~/.autonomous-qa/env`. Do not write the key into the repo, a flow, or tool arguments.

Each repo has `.autonomous-qa/config.yml` and `.autonomous-qa/flows/`. If the config file is missing, run `autonomous-qa init` in that repo before any browser tool. Init records the app URL, host allowlist, and project id. It does not register MCP for that repo.

`allowedHosts`, `productionAllowed`, and destructive-action policy come from the repo. User config cannot change them.

When several workspace roots are open, pass `projectRoot` set to the root that contains `.autonomous-qa/config.yml`.

A project `.cursor/mcp.json` server named `autonomous-qa` overrides the user-level server.
