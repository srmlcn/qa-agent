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

/**
 * Serves the archive fixture on 127.0.0.1.
 * Archived projects stay hidden until `close`.
 */
export function start(port: number): Promise<ArchiveApp> {
  assertPort(port);
  const archived = new Set<string>();
  const server = createServer((request, response) => {
    handle(request, response, archived).catch((error: unknown) => {
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
      renderPage(archived, {
        menu: url.searchParams.get("menu") === ALPHA_ID,
        confirm: url.searchParams.get("confirm") === ALPHA_ID,
      }),
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/archive") {
    const id = new URLSearchParams(await readBody(request)).get("id");
    if (id === ALPHA_ID) {
      archived.add(ALPHA_ID);
    }
    redirect(response, "/");
    return;
  }

  sendText(response, 404, "Not found");
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

type PageQuery = {
  menu: boolean;
  confirm: boolean;
};

function renderPage(archived: ReadonlySet<string>, query: PageQuery): string {
  const active = !archived.has(ALPHA_ID);
  const body = active
    ? renderProject(query.menu, query.confirm)
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

function renderProject(menuOpen: boolean, confirmOpen: boolean): string {
  const menu = menuOpen ? renderArchiveMenu() : "";
  const confirm = confirmOpen ? renderConfirm() : "";
  return `<section>
<p>${escapeHtml(ALPHA_NAME)}</p>
<form method="get" action="/">
<input type="hidden" name="menu" value="${escapeHtml(ALPHA_ID)}">
<button type="submit">Options for ${escapeHtml(ALPHA_NAME)}</button>
</form>
${menu}
${confirm}
</section>`;
}

function renderArchiveMenu(): string {
  return `<form method="get" action="/">
<input type="hidden" name="confirm" value="${escapeHtml(ALPHA_ID)}">
<div role="menu">
<button type="submit" role="menuitem">Archive</button>
</div>
</form>`;
}

function renderConfirm(): string {
  return `<form method="post" action="/archive">
<input type="hidden" name="id" value="${escapeHtml(ALPHA_ID)}">
<p>Archive this project?</p>
<button type="submit" data-testid="confirm-archive">Archive project</button>
</form>`;
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
