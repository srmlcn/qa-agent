import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const LOOPBACK = "127.0.0.1";
const ALPHA_ID = "alpha";
const ALPHA_NAME = "Alpha";
const COOKIE_NAME = "qa_session";
const SESSION_VALUE = "session-owner";
const MAX_BODY_BYTES = 4096;

/** Login username for this fixture. */
export const USERNAME = "owner";

/**
 * Login password for this fixture.
 * This is the only copy of the value. Callers must not print it.
 */
export const PASSWORD = "owner-secret";

export type AuthApp = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Serves the authenticated archive fixture on 127.0.0.1.
 * `/app` requires cookie `qa_session`. The password is never written to a response.
 */
export function start(port: number): Promise<AuthApp> {
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
                : new Error("Could not start the auth fixture."),
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
    throw new Error("Auth fixture did not bind a TCP port.");
  }
  if (address.address !== LOOPBACK) {
    throw new Error(
      `Auth fixture bound ${address.address} instead of ${LOOPBACK}.`,
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
  const signedIn = hasSession(request);

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    if (signedIn) {
      redirect(response, "/app");
      return;
    }
    sendHtml(response, renderLogin());
    return;
  }

  if (request.method === "POST" && url.pathname === "/login") {
    const params = new URLSearchParams(await readBody(request));
    if (credentialsMatch(params)) {
      redirect(response, "/app", sessionCookie());
      return;
    }
    sendHtml(response, renderLogin(), 401);
    return;
  }

  if (request.method === "GET" && url.pathname === "/app") {
    if (!signedIn) {
      redirect(response, "/");
      return;
    }
    sendHtml(response, renderPage(archived, queryFrom(url)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/archive") {
    if (!signedIn) {
      redirect(response, "/");
      return;
    }
    const id = new URLSearchParams(await readBody(request)).get("id");
    if (id === ALPHA_ID) {
      archived.add(ALPHA_ID);
    }
    redirect(response, "/app");
    return;
  }

  sendText(response, 404, "Not found");
}

function hasSession(request: IncomingMessage): boolean {
  return readCookie(request, COOKIE_NAME) === SESSION_VALUE;
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

function credentialsMatch(params: URLSearchParams): boolean {
  return (
    params.get("username") === USERNAME && params.get("password") === PASSWORD
  );
}

function sessionCookie(): string {
  return `${COOKIE_NAME}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`;
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

function renderLogin(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in</title>
</head>
<body>
<main>
<h1>Sign in</h1>
<form method="post" action="/login">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="username">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`;
}

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
<form method="get" action="/app">
<input type="hidden" name="menu" value="${escapeHtml(ALPHA_ID)}">
<button type="submit">Options for ${escapeHtml(ALPHA_NAME)}</button>
</form>
${menu}
${confirm}
</section>`;
}

function renderArchiveMenu(): string {
  return `<form method="get" action="/app">
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

function redirect(
  response: ServerResponse,
  location: string,
  setCookie?: string,
): void {
  const headers: Record<string, string> = {
    Location: location,
    "Content-Length": "0",
    "Cache-Control": "no-store",
  };
  if (setCookie !== undefined) {
    headers["Set-Cookie"] = setCookie;
  }
  response.writeHead(303, headers);
  response.end();
}

function sendHtml(response: ServerResponse, html: string, status = 200): void {
  send(response, status, "text/html; charset=utf-8", html);
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
