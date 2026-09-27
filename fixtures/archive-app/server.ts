import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const LOOPBACK = "127.0.0.1";
const ALPHA_ID = "alpha";
const ALPHA_NAME = "Alpha";
const MAX_BODY_BYTES = 4096;

export type ArchiveApp = {
  url: string;
  close: () => Promise<void>;
};

/** UI breakage modes. `original` keeps the names the saved flow targets. */
export type ArchiveVariant = "original" | "renamed" | "moved" | "modal";

export type ArchiveAppOptions = {
  /** Defaults to `original`. */
  variant?: ArchiveVariant;
};

/**
 * Serves the archive fixture on 127.0.0.1.
 * Archived projects stay hidden until `close`.
 * `options.variant` defaults to `original` so existing callers stay on the current UI.
 */
export function start(
  port: number,
  options: ArchiveAppOptions = {},
): Promise<ArchiveApp> {
  assertPort(port);
  const variant = resolveVariant(options.variant);
  const archived = new Set<string>();
  const server = createServer((request, response) => {
    handle(request, response, archived, variant).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      const message =
        error instanceof Error ? error.message : "Could not handle the request.";
      sendText(response, 500, message);
    });
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing === undefined) {
      closing = shutdown(server);
    }
    return closing;
  };

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK, () => {
      server.off("error", onError);
      let url: string;
      try {
        url = boundUrl(server);
      } catch (error) {
        void close()
          .catch(() => undefined)
          .then(() => {
            reject(
              error instanceof Error
                ? error
                : new Error("Could not start the archive fixture."),
            );
          });
        return;
      }
      resolve({ url, close });
    });
  });
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Port must be an integer from 0 through 65535. Received ${String(port)}.`,
    );
  }
}

function resolveVariant(variant: ArchiveVariant | undefined): ArchiveVariant {
  if (variant === undefined) {
    return "original";
  }
  if (
    variant !== "original" &&
    variant !== "renamed" &&
    variant !== "moved" &&
    variant !== "modal"
  ) {
    throw new Error(
      `Archive fixture variant must be original, renamed, moved, or modal. Received ${String(variant)}.`,
    );
  }
  return variant;
}

function boundUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Archive fixture did not bind a TCP port.");
  }
  if (address.address !== LOOPBACK) {
    throw new Error(
      `Archive fixture bound ${address.address} instead of ${LOOPBACK}.`,
    );
  }
  return `http://${LOOPBACK}:${address.port}`;
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  archived: Set<string>,
  variant: ArchiveVariant,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(
      response,
      variant === "moved"
        ? renderMovedHome()
        : renderPage(archived, queryFrom(url), variant),
    );
    return;
  }

  if (
    request.method === "GET" &&
    variant === "moved" &&
    url.pathname === "/projects"
  ) {
    sendHtml(response, renderPage(archived, queryFrom(url), variant));
    return;
  }

  if (request.method === "POST" && url.pathname === "/archive") {
    const id = new URLSearchParams(await readBody(request)).get("id");
    if (id === ALPHA_ID) {
      archived.add(ALPHA_ID);
    }
    redirect(response, listPath(variant));
    return;
  }

  sendText(response, 404, "Not found");
}

type PageQuery = {
  menu: boolean;
  confirm: boolean;
};

function queryFrom(url: URL): PageQuery {
  return {
    menu: url.searchParams.get("menu") === ALPHA_ID,
    confirm: url.searchParams.get("confirm") === ALPHA_ID,
  };
}

function listPath(variant: ArchiveVariant): string {
  return variant === "moved" ? "/projects" : "/";
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        error instanceof Error
          ? error
          : new Error("Could not read the request body."),
      );
    };

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", fail);
  });
}

function renderMovedHome(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Home</title>
</head>
<body>
<header><p>Signed in as project owner</p></header>
<main>
<p><a href="/projects">Projects</a></p>
</main>
</body>
</html>
`;
}

function renderPage(
  archived: ReadonlySet<string>,
  query: PageQuery,
  variant: ArchiveVariant,
): string {
  const active = !archived.has(ALPHA_ID);
  const body = active
    ? renderProject(query.menu, query.confirm, variant)
    : "<p>No active projects.</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Projects</title>
</head>
<body>
<header><p>Signed in as project owner</p></header>
<main>
<h1>Projects</h1>
${body}
</main>
</body>
</html>
`;
}

function renderProject(
  menuOpen: boolean,
  confirmOpen: boolean,
  variant: ArchiveVariant,
): string {
  const action = listPath(variant);
  const menu = menuOpen ? renderArchiveMenu(variant, action) : "";
  const confirm = confirmOpen ? renderConfirm(variant) : "";
  return `<section>
<p>${escapeHtml(ALPHA_NAME)}</p>
<form method="get" action="${action}">
<input type="hidden" name="menu" value="${escapeHtml(ALPHA_ID)}">
<button type="submit">Options for ${escapeHtml(ALPHA_NAME)}</button>
</form>
${menu}
${confirm}
</section>`;
}

function renderArchiveMenu(variant: ArchiveVariant, action: string): string {
  const name = variant === "renamed" ? "Move to archive" : "Archive";
  return `<form method="get" action="${action}">
<input type="hidden" name="confirm" value="${escapeHtml(ALPHA_ID)}">
<div role="menu">
<button type="submit" role="menuitem">${escapeHtml(name)}</button>
</div>
</form>`;
}

function renderConfirm(variant: ArchiveVariant): string {
  const form = `<form method="post" action="/archive">
<input type="hidden" name="id" value="${escapeHtml(ALPHA_ID)}">
${variant === "modal" ? "" : "<p>Archive this project?</p>"}
<button type="submit" data-testid="confirm-archive">Archive project</button>
</form>`;
  if (variant !== "modal") {
    return form;
  }
  return `<dialog open aria-modal="true" aria-labelledby="archive-dialog-title">
<h2 id="archive-dialog-title">Archive this project?</h2>
${form}
</dialog>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, {
    Location: location,
    "Content-Length": "0",
    "Cache-Control": "no-store",
  });
  response.end();
}

function sendHtml(response: ServerResponse, html: string): void {
  send(response, 200, "text/html; charset=utf-8", html);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  send(response, status, "text/plain; charset=utf-8", text);
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  text: string,
): void {
  const body = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'",
  });
  response.end(body);
}
