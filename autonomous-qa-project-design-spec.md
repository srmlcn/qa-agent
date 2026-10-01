# Autonomous QA Orchestrator — Project Design Specification

**Status:** Draft v0.1  
**Primary interface:** Cursor via MCP  
**Runtime:** Local Node.js/TypeScript package  
**Primary browser executor:** Playwright  
**Exploration engine:** Stagehand  
**Stagehand model source:** Stagehand's provider client, or a custom OpenAI-compatible endpoint  
**Primary goal:** Autonomously discover, compile, execute, and evaluate user-facing flows for a feature branch or bug fix.

---

## 1. Objective

Build an installable QA runtime that Cursor can orchestrate through MCP.

The system must let Cursor take a feature branch or bug-fix objective and:

1. Determine what user-facing behavior needs validation.
2. Ask Stagehand to discover how that behavior is exercised in the running application.
3. Convert the discovered interaction trajectory into a reusable, typed `FlowSpec`.
4. Execute the `FlowSpec` directly with Playwright.
5. Run multiple flows or variants concurrently in isolated authenticated browser contexts.
6. Capture network, console, page, screenshot, trace, timing, and assertion evidence.
7. Return structured evidence to Cursor so Cursor can judge the feature against the code change, issue, or acceptance criteria.
8. Reinvoke Stagehand only when a new flow must be discovered or a previously valid flow becomes stale.

The central design rule is:

> **Cursor plans. Stagehand discovers. Playwright executes. The MCP server coordinates and records.**

Stagehand is not the permanent test runner. Playwright is not responsible for understanding an unknown UI. Cursor is not responsible for manually operating browser tabs.

---

## 2. High-Level Architecture

```text
                        Feature Branch / Bug Fix
                                  |
                                  v
                         +------------------+
                         |      Cursor      |
                         | planner/reviewer |
                         +--------+---------+
                                  |
                                  | MCP
                                  v
                  +---------------+----------------+
                  |       QA MCP Server            |
                  | orchestration + state + tools  |
                  +----+-----------------------+----+
                       |                       |
              discovery|                       |execution
                       v                       v
              +----------------+       +---------------+
              |   Stagehand    |       |  Playwright   |
              | UI exploration |       | flow runtime  |
              +-------+--------+       +-------+-------+
                      |                        |
                      | model calls            | browser contexts
                      v                        v
              +----------------+       +---------------+
              | Configured LLM |       | Chromium/etc. |
              | provider       |       | isolated auth |
              +----------------+       +---------------+
                      |
                      | discovered actions
                      v
              +----------------+
              | Flow Compiler  |
              | action -> spec |
              +-------+--------+
                      |
                      v
              +----------------+
              |    FlowSpec    |
              | reusable IR    |
              +-------+--------+
                      |
                      +----------------------+
                                             |
                                             v
                                    +----------------+
                                    | Evidence Store |
                                    | run artifacts  |
                                    +-------+--------+
                                            |
                                            v
                                          Cursor
                                      final QA judgment
```

---

## 3. Component Responsibilities

## 3.1 Cursor

### Role

Cursor is the top-level reasoning and orchestration agent.

Cursor understands the repository and therefore owns questions that require code context:

- What changed on this branch?
- What issue or acceptance criteria does the change address?
- Which existing flows are likely affected?
- Which scenarios should be tested?
- Which failures indicate a product defect versus an outdated QA flow?
- Does the collected evidence satisfy the intended feature?

### Cursor must not own

- Browser session persistence.
- Browser tabs.
- Authentication cookies.
- Parallel browser lifecycle.
- Raw Playwright worker management.
- Low-level DOM extraction.
- Stagehand model inference.
- Artifact storage.

### Inputs

- Git diff.
- Issue/ticket description.
- Existing repository context.
- Project QA configuration.
- Existing `FlowSpec` files.
- Structured results returned by the MCP server.

### Outputs

Cursor should call the MCP tools with explicit objectives such as:

```text
Validate that a signed-in project owner can archive an active project,
that cancellation leaves the project unchanged, and that the archived
state persists after reload.
```

Cursor may spawn subagents. Subagents interact with the same MCP server but receive separate run/session identifiers.

---

## 3.2 MCP Server

### Role

The MCP server is the stable boundary between Cursor and the QA runtime.

It owns:

- Tool schemas.
- Runtime state.
- Session IDs.
- Project configuration.
- Stagehand lifecycle.
- Playwright lifecycle.
- Flow persistence.
- Worker allocation.
- Artifact collection.
- Error normalization.
- Cancellation.
- Cleanup.

It should expose high-level QA operations rather than forcing Cursor to micromanage browser internals.

### Transport

Primary transport:

```text
stdio
```

This makes the package locally installable and directly usable by Cursor.

Future transport:

```text
HTTP MCP
```

for a shared/team-hosted QA service.

### Required MCP tools

#### `qa.status`

Returns installation, browser, LLM-provider, project, and runtime health.

#### `qa.discover_flow`

Inputs:

```ts
{
  objective: string;
  startUrl?: string;
  authProfile?: string;
  constraints?: string[];
  maxSteps?: number;
}
```

Behavior:

1. Start a discovery session.
2. Load authentication.
3. Invoke Stagehand.
4. Explore until the objective is completed or fails.
5. Capture the full action trajectory and checkpoints.
6. Pass the trajectory into the Flow Compiler.
7. Validate the compiled flow with Playwright.
8. Return a draft `FlowSpec`.

#### `qa.execute_flow`

Inputs:

```ts
{
  flowId: string;
  inputs?: Record<string, unknown>;
  authProfile?: string;
  headed?: boolean;
  collectTrace?: boolean;
}
```

Executes a saved `FlowSpec` using Playwright only unless recovery is explicitly enabled.

#### `qa.execute_suite`

Inputs:

```ts
{
  flowIds: string[];
  workers?: number;
  authStrategy?: "shared" | "per-worker";
}
```

Runs flows concurrently and returns an aggregate result.

#### `qa.repair_flow`

Inputs:

```ts
{
  flowId: string;
  failedStepId?: string;
  runId?: string;
}
```

Uses the failed deterministic flow plus its semantic intent as input to Stagehand, discovers the changed UI path, validates it, and proposes an updated `FlowSpec`.

#### `qa.get_run`

Returns structured run results and artifact references.

#### `qa.capture_auth`

Starts a headed Playwright browser so the user can authenticate, then securely persists Playwright storage state under the tool's home directory.

#### `qa.list_flows`

Returns project flow metadata without dumping every flow body into Cursor context.

#### `qa.cancel_run`

Cancels active discovery or execution work and cleans up browsers.

### Optional low-level debugging tools

These are useful when Cursor needs to investigate a framework failure:

- `browser.inspect`
- `browser.screenshot`
- `browser.network`
- `browser.console`
- `browser.trace`

They should not be the normal execution path.

---

## 3.3 Stagehand

### Role

Stagehand is the **UI discovery and recovery engine**.

It is used when the exact browser flow is not already known.

Typical responsibilities:

- Explore an unfamiliar UI.
- Find controls from semantic intent.
- Determine multi-step navigation paths.
- Resolve changed or stale selectors.
- Extract structured page information useful during discovery.
- Return the actions performed during exploration.

### Stagehand should be used for

```text
New feature with no known flow
Existing flow whose deterministic locator/path broke
UI exploration where Cursor knows the objective but not the interaction path
```

### Stagehand should not be used for

```text
Every regression run
Known deterministic flows
Routine assertions
Parallel replay
Network instrumentation
Long-term flow storage
```

### Model configuration

The QA runtime must wrap Stagehand behind an internal provider abstraction.

A custom OpenAI-compatible endpoint is required. It is not the only supported mode. Every provider for which Stagehand ships a client is also a supported mode, and that mode uses Stagehand's client for the provider.

Custom endpoint:

```yaml
llm:
  provider: openai-compatible
  model: company-model-name
  baseUrl: https://internal-model-server.example/v1
  apiKeyEnv: COMPANY_LLM_API_KEY
```

`openai-compatible` uses the custom chat-completions client. `baseUrl` is required. The request carries chat-completions fields a generic compatible server accepts. The runtime does not add OpenAI-only parameters such as reasoning effort.

OpenAI, through Stagehand's client:

```yaml
llm:
  provider: openai
  model: gpt-5.4
  apiKeyEnv: OPENAI_API_KEY
```

`openai` uses Stagehand's OpenAI client. The runtime must not substitute the custom chat-completions client for it, and it must not set or override reasoning effort. Stagehand's OpenAI client owns that default on structured `createChatCompletion`. For a GPT-5 minor model that is not Codex, that client uses `none`.

Any other provider Stagehand implements uses Stagehand's client for that provider in the same way. `anthropic` uses Stagehand's Anthropic client. `xai` uses Stagehand's xAI client. A Grok model is an `xai` model name, not a provider. The custom chat-completions client is only for `openai-compatible`.

The provider abstraction must support:

- Model name.
- Base URL. Required for `openai-compatible`. Optional when Stagehand's client has a default endpoint.
- API key environment variable.
- Additional headers.
- Timeout.
- Retry policy.
- Stagehand's client for a named provider.
- The custom chat-completions client for `openai-compatible`.
- Provider health check.

FlowSpec and Playwright replay must not depend on which vendor served discovery. The Stagehand adapter selects the vendor client. The compiled flow does not name that vendor.

### Stagehand output handling

Do not treat the agent's narrative completion message as authoritative.

Persist:

- Every concrete action.
- Target metadata/selectors if exposed.
- Action arguments.
- URL before and after.
- Page state/checkpoint.
- Stagehand success/failure result.
- Screenshots at meaningful transitions.
- Relevant network activity.

That trajectory becomes input to the Flow Compiler.

---

## 3.4 Flow Compiler

### Role

The Flow Compiler converts exploratory behavior into a reusable intermediate representation.

It is the boundary between:

```text
probabilistic discovery
```

and:

```text
deterministic execution
```

### It must not

Blindly copy Stagehand-generated XPath/CSS selectors into permanent tests.

### Locator preference

When compiling a target, prefer:

1. `getByRole` + accessible name.
2. `getByLabel`.
3. `getByPlaceholder`.
4. `getByText` when semantically appropriate.
5. Stable `data-testid`.
6. Stable application-specific attributes.
7. CSS selectors.
8. XPath only as a last resort.

### Compiler validation

A successful Stagehand trajectory is the proof that the generated clicks were possible.

The page left after those clicks is not the page they started on. A control can exist only while an invoice is unpaid, a menu is open, or a dialog is showing. Probing that end state, or replaying the click sequence to see that each locator still exists, rejects a flow that already succeeded. Loading between one click and the next makes that second pass fragile as well.

Discovery compiles the trajectory and saves it as `validated`. It does not launch a second browser to click the steps again. Playwright replay remains how a saved flow is executed later, on whatever application state that later run starts from.

Locator ranking still prefers a role, label, or other stable target recorded on the action. When the control is still on the page discovery finished on, a hidden field can be retargeted to its visible surface, and a locator that matches multiple elements is still rejected. A control that is simply gone is left as recorded.

---

## 3.5 FlowSpec

`FlowSpec` is the core persistent artifact.

It must be:

- Model-independent.
- Stagehand-independent.
- Playwright-executable.
- Human-readable.
- Versioned.
- Serializable as JSON or YAML.
- Suitable for source control.

### Example

```yaml
version: 1

id: project.archive
name: Archive an active project

objective: >
  A signed-in project owner can archive an active project and
  the archived state persists after reload.

authProfile: project-owner

inputs:
  projectName:
    type: string
    required: true

steps:
  - id: open-project-options
    intent: Open the options menu for the target project.
    action: click
    locator:
      type: role
      role: button
      name: "Options for ${projectName}"
    semanticFallback: >
      Find and open the actions or options menu associated with
      the project named ${projectName}.

  - id: select-archive
    intent: Choose the archive operation.
    action: click
    locator:
      type: role
      role: menuitem
      name: Archive
    semanticFallback: >
      Select the action that archives the current project.

  - id: confirm-archive
    intent: Confirm that the project should be archived.
    action: click
    locator:
      type: role
      role: button
      name: Archive project
    semanticFallback: >
      Confirm the archive operation in the confirmation UI.

assertions:
  - id: project-not-active
    type: not-visible
    locator:
      type: text
      text: "${projectName}"

  - id: persists-after-reload
    type: custom-sequence
    sequence:
      - action: reload
      - assert: not-visible
        locator:
          type: text
          text: "${projectName}"

evidence:
  screenshots:
    - after: confirm-archive
  network:
    capture: true
  console:
    errors: true
  trace:
    onFailure: true
```

### Flow states

```text
draft
  |
  v
validated
  |
  v
stable
  |
  +---- locator/path failure ----> stale
                                  |
                                  v
                               repaired
                                  |
                                  v
                               validated
```

---

## 3.6 Playwright Runtime

### Role

Playwright is the deterministic browser execution engine.

It owns:

- Browser lifecycle.
- Browser contexts.
- Pages.
- Authentication state.
- Parallel workers.
- Deterministic locator execution.
- Assertions.
- Network inspection.
- Console capture.
- Page errors.
- Screenshots.
- Traces.
- Timing.
- Downloads/uploads where required.

### Execution rule

If a validated `FlowSpec` exists, Playwright executes it directly without an LLM.

### Parallelism

Each parallel worker receives an isolated Playwright browser context.

For read-only/non-mutating tests, multiple contexts may reuse the same stored auth state.

For tests that mutate shared server-side state, support one account/auth profile per worker.

Configuration:

```yaml
playwright:
  browser: chromium
  headless: true
  workers: 4
  timeoutMs: 60000
  trace: on-failure
```

### Required instrumentation

For every run, optionally capture:

```text
request
response
request failure
console warning/error
uncaught page error
navigation
download
screenshot
Playwright trace
step timing
overall timing
```

Large bodies must be bounded by configurable size limits.

Secrets in headers, cookies, and request bodies must be redacted before persistence.

---

## 3.7 Authentication Manager

### Role

Authentication must be owned by the QA runtime, not by Cursor.

Storage location:

```text
~/.autonomous-qa/auth/<project-id>/<profile>.json
```

Never store authentication state in the repository.

### Auth workflow

```text
qa.capture_auth
      |
      v
headed Playwright session
      |
user/application performs login
      |
      v
context.storageState()
      |
      v
encrypted/protected local auth profile
```

### Required auth modes

- Interactive captured login.
- Pre-generated Playwright `storageState`.
- Environment-provided credentials for scripted login.
- Per-worker test accounts.
- Future pluggable auth providers.

### Security requirement

Auth state files contain impersonation-capable cookies/tokens and must:

- Never be committed.
- Use restrictive filesystem permissions.
- Be excluded from artifact output.
- Be redacted from logs.
- Be removable with a CLI command.

---

## 3.8 Evidence Collector

### Role

The Evidence Collector provides facts for Cursor's QA judgment.

### Run result

```ts
interface RunResult {
  runId: string;
  flowId: string;
  status: "passed" | "failed" | "error";
  startedAt: string;
  durationMs: number;

  steps: StepResult[];

  network: {
    failedRequests: NetworkFailure[];
    responses: NetworkRecord[];
  };

  console: {
    errors: ConsoleRecord[];
    warnings: ConsoleRecord[];
  };

  pageErrors: PageErrorRecord[];

  artifacts: {
    screenshots: string[];
    trace?: string;
  };

  failure?: {
    stepId?: string;
    category:
      | "assertion"
      | "locator"
      | "navigation"
      | "network"
      | "timeout"
      | "runtime";
    message: string;
  };
}
```

The evidence collector reports facts. It does not decide feature correctness beyond deterministic assertions.

---

## 3.9 Cursor QA Evaluation

Cursor receives:

- Branch/issue context.
- Intended acceptance criteria.
- FlowSpec.
- Playwright results.
- Network failures.
- Console/page errors.
- Screenshots or screenshot references.
- Trace information.
- Failure category.

Cursor then performs the final semantic evaluation.

Example:

```text
Requirement:
Archiving must persist.

Observed:
Archive mutation returned 200.
Project disappeared.
Reload caused project to reappear.

Conclusion:
The UI action completed but the required persisted behavior failed.
```

This keeps semantic judgment in the agent that already understands the repository and feature request.

---

## 4. Feature-Branch Evaluation Lifecycle

### Phase 1 — Plan

Cursor inspects:

```text
git diff
ticket/issue
changed files
existing FlowSpecs
```

Cursor identifies:

- New behavior.
- Existing behavior at regression risk.
- Required user roles.
- Candidate edge cases.

### Phase 2 — Resolve flows

For each scenario:

```text
Known validated FlowSpec?
        |
   +----+----+
   |         |
  yes        no
   |         |
   v         v
replay    Stagehand
          discovery
              |
              v
         Flow Compiler
              |
              v
       Playwright validation
```

### Phase 3 — Execute

Playwright distributes scenarios to workers.

```text
worker 1 -> happy path
worker 2 -> cancel/error path
worker 3 -> permission variant
worker 4 -> persistence/reload variant
```

### Phase 4 — Collect

Every worker returns structured evidence.

### Phase 5 — Evaluate

Cursor compares evidence against acceptance criteria and code context.

### Phase 6 — Repair

A failed flow is classified.

#### Product failure

The intended control/state does not exist or behavior violates the requirement.

Result:

```text
QA failure
```

#### Flow failure

Functionality still exists but deterministic navigation/locator is stale.

Result:

```text
invoke qa.repair_flow
Stagehand discovers current path
Compiler updates FlowSpec
Playwright revalidates
```

A repaired flow must never silently convert an application failure into a pass. The original failure and repair evidence must remain available.

---

## 5. Installation and Local Layout

### Package

Target installation:

```bash
npm install -g autonomous-qa
```

or zero-install:

```bash
npx autonomous-qa init
```

### Home-directory runtime

```text
~/.autonomous-qa/
├── config.json
├── auth/
├── cache/
├── browsers/
├── logs/
└── projects/
```

### Repository-local configuration

```text
project/
├── .autonomous-qa/
│   ├── config.yml
│   └── flows/
│       ├── project-create.yml
│       └── project-archive.yml
└── ...
```

Recommended `.gitignore`:

```text
.autonomous-qa/artifacts/
.autonomous-qa/runtime/
playwright-report/
test-results/
```

Flows and non-secret configuration should be committable.

Authentication and runtime artifacts must not be stored in the repository.

---

## 6. Cursor MCP Configuration

The installer should be able to print or optionally install an MCP configuration equivalent to:

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

The server must write protocol messages only to stdout. Operational logs must go to stderr or files.

---

## 7. Project Configuration

Example `.autonomous-qa/config.yml`:

```yaml
version: 1

application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
  productionAllowed: false

llm:
  provider: openai-compatible
  model: company-ui-agent
  baseUrl: https://llm.company.internal/v1
  apiKeyEnv: COMPANY_LLM_API_KEY
  timeoutMs: 60000

stagehand:
  enabled: true
  maxSteps: 30
  recoveryEnabled: true

playwright:
  browser: chromium
  headless: true
  workers: 4
  timeoutMs: 60000

evidence:
  screenshots: checkpoints
  network: true
  console: true
  trace: on-failure
  maxResponseBodyBytes: 262144

security:
  redactHeaders:
    - authorization
    - cookie
    - set-cookie
  destructiveActionsAllowed: false
```

---

## 8. Safety and Environment Guardrails

Because the system autonomously interacts with applications, it must default to non-production use.

Required controls:

- Explicit host allowlist.
- Production execution disabled by default.
- Configurable destructive-action policy.
- Request/response secret redaction.
- Cookie redaction.
- Maximum discovery step count.
- Maximum run duration.
- Browser/process cleanup on cancellation.
- Bounded artifact sizes.
- No shell execution exposed through browser tools.
- No arbitrary filesystem access exposed through MCP QA tools.
- Audit record for discovery and repair actions.

---

## 9. Repository Design

Recommended initial structure:

```text
autonomous-qa/
├── src/
│   ├── cli/
│   │   ├── init.ts
│   │   ├── doctor.ts
│   │   ├── auth.ts
│   │   └── mcp.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── tools.ts
│   │   └── schemas.ts
│   │
│   ├── orchestrator/
│   │   ├── discovery.ts
│   │   ├── execution.ts
│   │   ├── repair.ts
│   │   └── runs.ts
│   │
│   ├── stagehand/
│   │   ├── client.ts
│   │   ├── provider.ts
│   │   └── trajectory.ts
│   │
│   ├── flows/
│   │   ├── schema.ts
│   │   ├── compiler.ts
│   │   ├── resolver.ts
│   │   ├── validator.ts
│   │   └── repository.ts
│   │
│   ├── playwright/
│   │   ├── runtime.ts
│   │   ├── executor.ts
│   │   ├── workers.ts
│   │   ├── auth.ts
│   │   └── locators.ts
│   │
│   ├── evidence/
│   │   ├── network.ts
│   │   ├── console.ts
│   │   ├── screenshots.ts
│   │   ├── traces.ts
│   │   └── result.ts
│   │
│   ├── config/
│   │   ├── schema.ts
│   │   └── loader.ts
│   │
│   └── security/
│       ├── redaction.ts
│       └── policy.ts
│
├── fixtures/
│   ├── next-app/
│   ├── vue-app/
│   └── auth-app/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── package.json
├── tsconfig.json
└── README.md
```

Start as one package. Split into a monorepo only when independently versioned packages become necessary.

---

## 10. Testing Strategy

### Unit tests

Cover:

- FlowSpec schema.
- Flow compiler.
- Locator normalization.
- Configuration.
- Redaction.
- Run-state transitions.
- Failure classification.

### Integration tests

Use fixture applications to verify:

- Browser startup/shutdown.
- Auth persistence.
- Network capture.
- Console capture.
- Screenshot capture.
- Flow execution.
- Parallel contexts.
- MCP schemas.

### Stagehand integration tests

Maintain deterministic fixture UIs with known flows.

Test:

- Initial flow discovery.
- Changed button text.
- Changed page layout.
- Moved navigation.
- Modal introduction.
- Selector breakage followed by repair.

CI should use a mock/fake model client where possible for deterministic tests.

Live-model Stagehand tests should run separately because they are probabilistic and provider-dependent.

### End-to-end acceptance test

A complete acceptance test should:

1. Start the fixture application.
2. Capture/login with a QA auth profile.
3. Ask `qa.discover_flow` to discover a feature.
4. Persist the returned FlowSpec.
5. Execute it successfully through Playwright.
6. Execute four independent browser contexts concurrently.
7. Modify the fixture UI so the saved locator breaks.
8. Confirm deterministic execution reports a locator failure.
9. Invoke `qa.repair_flow`.
10. Confirm Stagehand discovers the new path.
11. Confirm the repaired flow passes.
12. Verify cookies/auth state never appear in logs or saved flow files.

---

## 11. Failure Semantics

Failures must be structured rather than emitted only as prose.

```text
DISCOVERY_FAILED
FLOW_COMPILE_FAILED
FLOW_VALIDATION_FAILED
LOCATOR_STALE
ASSERTION_FAILED
AUTH_EXPIRED
AUTH_MISSING
NETWORK_FAILURE
PAGE_ERROR
NAVIGATION_FAILED
TIMEOUT
BROWSER_CRASHED
LLM_PROVIDER_UNAVAILABLE
LLM_RATE_LIMITED
POLICY_BLOCKED
RUN_CANCELLED
```

Every error must contain:

- Machine-readable code.
- Human-readable message.
- Run ID.
- Flow ID if applicable.
- Step ID if applicable.
- Artifact references if available.
- Whether Stagehand recovery is appropriate.

---

## 12. Performance Model

The normal regression path must contain no LLM calls.

```text
Existing validated flow
        |
        v
Playwright execution
```

LLM calls occur only for:

```text
new flow discovery
stale flow recovery
explicit semantic extraction during exploration
```

This makes the expensive/probabilistic component proportional to application change rather than total test executions.

Parallelism is controlled by Playwright worker count and available machine resources.

---

## 13. MVP Scope

The first useful release should support:

- Local installation.
- Cursor MCP integration.
- Chromium.
- Stagehand discovery.
- Custom OpenAI-compatible LLM server.
- Stagehand's OpenAI client for the OpenAI API.
- Any other provider Stagehand ships a client for, using that client.
- FlowSpec generation.
- Flow validation.
- Deterministic Playwright replay.
- Persistent auth profiles.
- Parallel execution.
- Network and console capture.
- Screenshots.
- Playwright traces on failure.
- Flow repair through Stagehand.
- Structured run results.
- Fixture-app integration tests.

Explicitly defer:

- Hosted SaaS control plane.
- Remote browser farm.
- Team dashboard.
- Long-term analytics.
- Automatic GitHub PR comments.
- Cross-browser matrix beyond Chromium.
- Pixel-level visual regression service.
- Database seeding framework.
- Production execution by default.
- Automatic code modification.

Cursor remains responsible for code changes and branch reasoning.

---

## 14. Definition of Done for v0.1

A fresh user can:

```text
1. Install the package.
2. Run autonomous-qa init.
3. Configure an internal or public LLM provider.
4. Register the MCP server with Cursor.
5. Start the target application.
6. Capture an authenticated browser state.
7. Ask Cursor to validate a newly implemented feature.
8. Have Cursor invoke Stagehand to discover the unknown UI path.
9. Receive a validated FlowSpec.
10. Execute that flow through Playwright without another LLM call.
11. Run multiple scenarios concurrently.
12. Receive structured network, console, screenshot, trace, and assertion evidence.
13. Break the UI locator intentionally.
14. Have deterministic execution fail cleanly.
15. Invoke Stagehand repair.
16. Revalidate and persist the repaired flow.
```

No authentication state may leak into source control, FlowSpecs, MCP output, or logs.

---

## 15. Architectural Principles

### One reasoning owner per problem

- Cursor reasons about code and test intent.
- Stagehand reasons about unknown browser interaction.
- Playwright performs known browser interaction.

Do not ask multiple agents to independently solve the same problem unless explicitly performing comparative evaluation.

### Discover once, replay many times

Stagehand inference should be amortized across future deterministic executions.

### Semantic intent must survive selector changes

Every important interaction step stores both:

```text
deterministic locator
semantic fallback intent
```

The locator makes normal execution fast.

The semantic intent makes the flow repairable.

### Evidence before judgment

The runtime records objective browser facts. Cursor makes higher-level QA conclusions from those facts.

### Authentication belongs to the runtime

Cursor agents should receive session/profile identifiers, never raw cookies.

### Parallelism belongs to Playwright

Cursor may request parallel work, but Playwright controls actual worker/context isolation.

### Model provider independence

The internal company model, OpenAI through Stagehand's client, another Stagehand provider, or a future local model must be replaceable without changing FlowSpec or Playwright execution. The adapter selects the client. The flow does not.

---

## 16. Target End-State Workflow

A developer implements a feature and tells Cursor:

```text
Evaluate this branch before I open the PR.
```

Cursor:

```text
1. Reads the diff.
2. Determines user-visible behavior and regression risk.
3. Finds existing relevant flows.
4. Requests Stagehand discovery only for unknown behavior.
5. Receives validated FlowSpecs.
6. Requests parallel Playwright execution.
7. Reviews deterministic assertions, network behavior,
   console/page errors, screenshots, and traces.
8. Repairs stale flows when the product behavior is still valid.
9. Reports actual product defects separately from QA-infrastructure failures.
```

The steady-state execution path is therefore:

```text
Cursor
  |
  v
MCP QA Orchestrator
  |
  +---- unknown UI ----> Stagehand ----> configured LLM
  |                           |
  |                           v
  |                       FlowSpec
  |                           |
  +---------------------------+
                              |
                              v
                         Playwright
                              |
                     parallel contexts
                              |
                              v
                           Evidence
                              |
                              v
                            Cursor
```

That is the intended product boundary.
