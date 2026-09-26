# autonomous-qa

This repository is a local QA runtime. Cursor plans, Stagehand discovers, Playwright executes, and MCP coordinates.

The design source of truth is [autonomous-qa-project-design-spec.md](autonomous-qa-project-design-spec.md).

## Module ownership

Edit only the module a leaf issue owns. The directory names match the list in `src/index.ts`.

| Module | Owns |
| --- | --- |
| `src/cli` | Command-line entrypoints: the command registry, init, doctor, and auth profile commands |
| `src/mcp` | The stdio MCP server and tool schemas that coordinate Cursor with the runtime |
| `src/orchestrator` | Discovery, single-flow and suite execution, repair, and run tracking |
| `src/stagehand` | Bounded UI discovery, the model-provider adapter, and recorded trajectories |
| `src/flows` | FlowSpec schema, compilation, locator ranking, replay validation, lifecycle, and on-disk storage |
| `src/playwright` | Chromium launch, FlowSpec actions and assertions, locator resolution, and isolated worker contexts |
| `src/evidence` | Run results and captured network, console, screenshot, and trace facts |
| `src/config` | Project and user configuration loading, validation, and merge precedence |
| `src/security` | Secret redaction, the host allowlist, and action and resource budgets |
| `src/errors` | Structured QA error codes and the `QaError` type |
| `src/runtime` | Home-directory paths under `~/.autonomous-qa/` and the stderr logger |
| `src/health` | The shared health report for the package, Node, config, Chromium, LLM environment presence, and home-directory permissions |

## Working rules

One leaf issue, one pull request. Edit only the paths that issue owns.

Do not rewrite the design spec while implementing a leaf.

Conventional commit types: `feat`, `fix`, `test`, `docs`, `ci`, `refactor`, `chore`.

## Non-goals

- Hosted SaaS
- Remote browser farm
- Team dashboard
- Analytics
- Automatic PR comments
- Browsers other than Chromium
- Pixel visual regression
- Database seeding
- Production by default
- Automatic code modification
- HTTP MCP
- Publishing to the public npm registry

## Operator path

Documented when the v0.1 commands exist.
