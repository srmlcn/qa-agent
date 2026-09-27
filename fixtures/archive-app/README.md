# Archive fixture

Signed-in project list for flow `project.archive`. Alpha starts active. Archiving it removes Alpha for the rest of this server process, including after reload. State stays in memory.

## Accessible names

- `Options for Alpha` — button that opens the menu
- `Archive` — menu item that asks for confirmation
- `Archive project` — button that confirms the archive

## Expected flow

Flow id: `project.archive`

1. Press Options for Alpha.
2. Choose Archive.
3. Press Archive project.
4. Alpha is gone from the list and stays gone after reload.

## Server

`server.ts` exports `start(port)`, which binds `127.0.0.1` and returns `{ url, close }`. `close()` stops listening. The confirm button carries the page's single `data-testid` (`confirm-archive`).
