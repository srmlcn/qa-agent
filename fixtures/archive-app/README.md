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

`server.ts` exports `start(port, options?)`, which binds `127.0.0.1` and returns `{ url, close }`. `close()` stops listening. The confirm button carries the page's single `data-testid` (`confirm-archive`).

`options.variant` defaults to `original`.

- `original` keeps the names above
- `renamed` changes the menu item from `Archive` to `Move to archive`
- `moved` places the options control on `/projects`, linked from the home page as `Projects`
- `modal` inserts a dialog titled `Archive this project?` before the confirm button, whose name stays `Archive project`

## Saved flow

`flows/project--archive.yml` is fixture test data for flow id `project.archive`. It targets the original names. It is not a user project flow.
