import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import {
  redactBody,
  redactCookies,
  redactHeaders,
} from "../../../src/security/redaction.js";

test("Authorization: Bearer secret becomes Authorization: [redacted]", () => {
  const redacted = redactHeaders({
    Authorization: "Bearer secret",
    Accept: "application/json",
  });

  expect(redacted.Authorization).toBe("[redacted]");
  expect(`Authorization: ${redacted.Authorization}`).toBe(
    "Authorization: [redacted]",
  );
  expect(redacted.Accept).toBe("application/json");
  expect(
    redactHeaders({ authorization: "Bearer secret" }).authorization,
  ).toBe("[redacted]");
  expect(redactBody("Authorization: Bearer secret", 1024)).toBe(
    "Authorization: [redacted]",
  );
});

test("a storage-state document keeps cookie names and loses cookie values", () => {
  const secret = "storage-state-cookie-secret";
  const document = {
    cookies: [
      {
        name: "session",
        value: secret,
        domain: "example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "theme", value: "light" }],
      },
    ],
  };

  const redacted = redactCookies(JSON.stringify(document));
  const parsed = JSON.parse(redacted) as {
    cookies: Array<{ name: string; value: string; domain: string }>;
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };

  expect(parsed.cookies[0]?.name).toBe("session");
  expect(parsed.cookies[0]?.value).toBe("[redacted]");
  expect(parsed.cookies[0]?.domain).toBe("example.com");
  expect(parsed.origins[0]?.localStorage[0]).toEqual({
    name: "theme",
    value: "light",
  });
  expect(redacted).not.toContain(secret);
});

test("truncation after redaction does not leave the secret in the kept prefix", () => {
  const secret = "SUPERSECRET1234567890";
  const body = `{"password":"${secret}","note":"${"y".repeat(400)}"}`;
  const maxBytes = 24;
  const result = redactBody(body, maxBytes);
  const kept = result.slice(0, result.length - "\n[truncated]".length);

  expect(result.endsWith("\n[truncated]")).toBe(true);
  expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(maxBytes);
  expect(kept).not.toContain(secret);
  expect(result).not.toContain(secret);
  expect(kept).toContain("[redacted]");
});

test("redacts cookie assignments while keeping cookie names", () => {
  expect(redactCookies("Cookie: session=secret; theme=dark")).toBe(
    "Cookie: session=[redacted]; theme=[redacted]",
  );
  expect(redactCookies("Set-Cookie: session=secret; Path=/; HttpOnly")).toBe(
    "Set-Cookie: session=[redacted]; Path=/; HttpOnly",
  );
  expect(redactCookies('document.cookie = "session=secret; path=/"')).toBe(
    'document.cookie = "session=[redacted]; path=/"',
  );
  expect(redactCookies("session=secret; theme=dark")).toBe(
    "session=[redacted]; theme=[redacted]",
  );
});

test("redacts sensitive JSON keys and leaves other fields", () => {
  const result = redactBody(
    '{"user":"ada","access_token":"tok","refresh_token":"ref","id_token":"id","apiKey":"key","api_key":"k","password":"pw","secret":"s","nested":{"password":"again"}}',
    10_000,
  );
  const parsed = JSON.parse(result) as {
    user: string;
    access_token: string;
    refresh_token: string;
    id_token: string;
    apiKey: string;
    api_key: string;
    password: string;
    secret: string;
    nested: { password: string };
  };

  expect(parsed.user).toBe("ada");
  expect(parsed.access_token).toBe("[redacted]");
  expect(parsed.refresh_token).toBe("[redacted]");
  expect(parsed.id_token).toBe("[redacted]");
  expect(parsed.apiKey).toBe("[redacted]");
  expect(parsed.api_key).toBe("[redacted]");
  expect(parsed.password).toBe("[redacted]");
  expect(parsed.secret).toBe("[redacted]");
  expect(parsed.nested.password).toBe("[redacted]");
  expect(result).not.toContain("again");
});

test("input object is not mutated", () => {
  const setCookie = ["session=secret; Path=/"];
  const headers = {
    Authorization: "Bearer secret",
    Cookie: "session=secret",
    "Set-Cookie": setCookie,
    Accept: ["application/json"],
  };
  const snapshot = {
    Authorization: headers.Authorization,
    Cookie: headers.Cookie,
    "Set-Cookie": headers["Set-Cookie"],
    Accept: headers.Accept,
  };

  const redacted = redactHeaders(headers);

  expect(headers).toEqual(snapshot);
  expect(headers["Set-Cookie"]).toBe(setCookie);
  expect(setCookie).toEqual(["session=secret; Path=/"]);
  expect(redacted).not.toBe(headers);
  expect(redacted.Authorization).toBe("[redacted]");
  expect(redacted.Cookie).toBe("[redacted]");
  expect(redacted["Set-Cookie"]).toEqual(["[redacted]"]);
  expect(redacted["Set-Cookie"]).not.toBe(setCookie);
  expect(redacted.Accept).toEqual(["application/json"]);
  expect(redacted.Accept).not.toBe(headers.Accept);
});
