import "server-only";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";

export function databaseTlsOptions(): ConnectionOptions {
  const inline = process.env.DATABASE_CA_CERT?.trim();
  const path = process.env.DATABASE_CA_CERT_PATH?.trim();
  // Project settings can supply PEM directly, without bundling a private file.
  // Invalid configured trust must fail, never silently fall back to another CA.
  const ca = inline ? inline.replace(/\\n/g, "\n").replace(/\r\n/g, "\n") : path ? readFileSync(path, "utf8") : undefined;
  if (ca !== undefined) {
    const certificate = new X509Certificate(ca);
    if (!certificate.ca || !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(ca)) {
      throw new Error("Configure a valid PostgreSQL CA certificate");
    }
  }
  // pg supplies the actual connection host/servername. Leave Node's default
  // checkServerIdentity enabled; neither chain nor hostname checks are bypassed.
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}
