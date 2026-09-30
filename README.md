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

1. Install the latest release into the environment Cursor uses for the workspace. Node.js 22 or newer must already be on `PATH`.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/srmlcn/qa-agent/main/scripts/install.sh | sh
   ```

   The script asks whether to install into `~/.autonomous-qa`. Answer `n` to type another absolute path. A leading `~/` is expanded. Without a terminal, it uses `~/.autonomous-qa`. `sh install.sh /absolute/path` selects that path and skips the question. The script downloads `autonomous-qa.tgz` from the latest GitHub release and runs `install`.

   From a checkout, the same install is:

   ```sh
   npm install
   npm run build
   node dist/cli/main.js install
   ```

   `install` copies the built app to `<install-dir>/app` and Chromium to `<install-dir>/browsers`. The default install directory is `~/.autonomous-qa`. It merges a stdio server into `~/.cursor/mcp.json`. The server command is the absolute Node binary that ran `install`, so Cursor does not need `autonomous-qa` on `PATH`. It also copies the agent skill to `~/.cursor/skills/autonomous-qa/SKILL.md`.

   LLM connection fields go in `<install-dir>/config.json` when that file is missing. The API key value goes in `<install-dir>/env` (mode `0600`) under the name `llm.apiKeyEnv`. `install` does not print the key. Re-run `install` after a new build. Pass `--force` to replace an existing `autonomous-qa` server entry.

   Reload Cursor after install. Cloud agents do not read `~/.cursor/mcp.json`.

2. Open any repo. Global settings apply without writing `.cursor` or `.autonomous-qa`. The built-in application defaults are `baseUrl: http://localhost:3000`, `allowedHosts: [localhost]`, and `productionAllowed: false`. Flows and artifacts for a repo that has no `.autonomous-qa` directory are stored in `~/.autonomous-qa/projects/<project-id>/`.

3. Add `.autonomous-qa/config.yml` only when that repo must override a global key or commit flows. A key in the repo file replaces the same global key. Omitted keys stay global. `allowedHosts`, `productionAllowed`, and `security` cannot be set in the user config. A repo `allowedHosts` list replaces the default list. `apiKeyEnv` is the name of an environment variable. The key value lives in the environment or `~/.autonomous-qa/env`, not in either config file.

   `autonomous-qa init` or `node dist/cli/main.js init` creates the repo directory, the flows directory, and gitignore entries for `.autonomous-qa/artifacts/` and `.autonomous-qa/runtime/`. It does not ignore `.autonomous-qa/flows/` or `.autonomous-qa/config.yml`. When the user `llm` block is already complete, init omits `llm` from the project file. `--install-mcp` is the explicit way to write a project MCP server.

4. The user MCP server is:

   ```json
   {
     "mcpServers": {
       "autonomous-qa": {
         "type": "stdio",
         "command": "/absolute/path/to/node",
         "args": ["/absolute/path/to/.autonomous-qa/app/dist/cli/main.js", "mcp"]
       }
     }
   }
   ```

   `install` writes that entry with `envFile` pointed at `~/.autonomous-qa/env`. A project `.cursor/mcp.json` server named `autonomous-qa` overrides it. `autonomous-qa init --install-mcp` still writes a project server that uses the `autonomous-qa` command, for a team that commits one. That command is not on `PATH` until it is linked. Prefer the user install for a personal setup.

5. Capture an auth profile with `autonomous-qa auth capture --project <project-id> --profile <profile> --url <start-url>`. The command is implemented in `src/cli/commands/auth.ts`. It writes the profile file to `<home>/auth/<project-id>/<profile>.json`. Home defaults to `~/.autonomous-qa` and can be overridden with `AUTONOMOUS_QA_HOME`.

6. A Cursor session calls `qa.status`, `qa.discover_flow`, `qa.execute_flow`, `qa.execute_suite`, `qa.repair_flow`, `qa.get_run`, `qa.capture_auth`, `qa.list_flows`, and `qa.cancel_run`. Replay (`qa.execute_flow` and `qa.execute_suite`) does not call the LLM. `qa.ping` is a smoke tool and is not required.

7. A locator failure is `RunResult.failure.category` equal to `locator`.

8. `qa.repair_flow` repairs a stale flow only for that locator failure. Assertion failures are not repaired.

9. When a repo has `.autonomous-qa`, its `flows` and `config.yml` are committable. Auth profiles and artifacts are not. Artifacts in a bare repo stay under the home project directory.
