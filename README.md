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

1. From a checkout, install dependencies and build the package:

   ```sh
   npm install
   npm run build
   ```

   Until a publish issue exists, run the CLI with a local `npm link` or with `node dist/cli/main.js`.

2. Create the project files with `autonomous-qa init` or `node dist/cli/main.js init`. Init writes `.autonomous-qa/config.yml` and `.autonomous-qa/flows/`. It appends `.gitignore` entries for `.autonomous-qa/artifacts/` and `.autonomous-qa/runtime/`. It does not ignore `.autonomous-qa/flows/` or `.autonomous-qa/config.yml`.

3. Set `llm.provider`, `baseUrl`, and `apiKeyEnv` in `.autonomous-qa/config.yml`. `apiKeyEnv` is the name of an environment variable, such as `COMPANY_LLM_API_KEY`. The key value lives in the environment, not in the file.

   ```yaml
   llm:
     provider: openai-compatible
     baseUrl: https://llm.company.internal/v1
     apiKeyEnv: COMPANY_LLM_API_KEY
   ```

4. Init prints this MCP server block:

   ```json
   {
     "mcpServers": {
       "autonomous-qa": {
         "type": "stdio",
         "command": "autonomous-qa",
         "args": ["mcp"]
       }
     }
   }
   ```

   `autonomous-qa init --install-mcp` writes that server into `.cursor/mcp.json`.

5. Capture an auth profile with `autonomous-qa auth capture --project <project-id> --profile <profile> --url <start-url>`. The command is implemented in `src/cli/commands/auth.ts`. It writes the profile file to `<home>/auth/<project-id>/<profile>.json`. Home defaults to `~/.autonomous-qa` and can be overridden with `AUTONOMOUS_QA_HOME`.

6. A Cursor session calls `qa.status`, `qa.discover_flow`, `qa.execute_flow`, `qa.execute_suite`, `qa.repair_flow`, `qa.get_run`, `qa.capture_auth`, `qa.list_flows`, and `qa.cancel_run`. Replay (`qa.execute_flow` and `qa.execute_suite`) does not call the LLM. `qa.ping` is a smoke tool and is not required.

7. A locator failure is `RunResult.failure.category` equal to `locator`.

8. `qa.repair_flow` repairs a stale flow only for that locator failure. Assertion failures are not repaired.

9. `.autonomous-qa/flows` and `.autonomous-qa/config.yml` are committable. Auth profiles and `.autonomous-qa/artifacts` are not.
