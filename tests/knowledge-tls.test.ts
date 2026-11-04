import { afterEach, describe, expect, it, vi } from "vitest";
import { rootCertificates } from "node:tls";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseTlsOptions } from "@/server/knowledge/tls";

const ca = rootCertificates[0]!;
afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL deployment trust", () => {
  it("preserves verified Node trust and default hostname checks without a custom CA", () => {
    vi.stubEnv("DATABASE_CA_CERT", ""); vi.stubEnv("DATABASE_CA_CERT_PATH", "");
    expect(databaseTlsOptions()).toEqual({ rejectUnauthorized: true });
    expect(databaseTlsOptions()).not.toHaveProperty("checkServerIdentity");
    expect(databaseTlsOptions()).not.toHaveProperty("servername");
  });
  it("accepts a PEM environment value ahead of an unavailable local file", () => {
    vi.stubEnv("DATABASE_CA_CERT", ca); vi.stubEnv("DATABASE_CA_CERT_PATH", "/nonexistent/local-only-ca.pem");
    expect(databaseTlsOptions()).toEqual({ rejectUnauthorized: true, ca });
  });
  it("supports literal newline separators pasted through project settings", () => {
    vi.stubEnv("DATABASE_CA_CERT", ca.replace(/\n/g, "\\n"));
    expect(databaseTlsOptions()).toEqual({ rejectUnauthorized: true, ca });
  });
  it("preserves the existing local file fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "narak-ca-test-"));
    try {
      const file = join(directory, "root.pem"); writeFileSync(file, ca);
      vi.stubEnv("DATABASE_CA_CERT", ""); vi.stubEnv("DATABASE_CA_CERT_PATH", file);
      expect(databaseTlsOptions()).toEqual({ rejectUnauthorized: true, ca: readFileSync(file, "utf8") });
    } finally { rmSync(directory, { recursive: true }); }
  });
  it.each(["invalid PEM", "-----BEGIN PRIVATE KEY-----\nnot-a-certificate\n-----END PRIVATE KEY-----", ca + "\nUNEXPECTED TRAILING DATA"])("fails closed for malformed inline trust without using a fallback", (value) => {
    vi.stubEnv("DATABASE_CA_CERT", value); vi.stubEnv("DATABASE_CA_CERT_PATH", "/nonexistent/fallback.pem");
    expect(() => databaseTlsOptions()).toThrow();
  });
});
