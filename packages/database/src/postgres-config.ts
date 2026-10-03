import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { checkServerIdentity, createSecureContext } from "node:tls";
import { ConfigurationError } from "@zentra/domain";
import type { PoolConfig } from "pg";

type DatabaseRuntimeConfig = {
  NODE_ENV: "development" | "test" | "production";
  DATABASE_URL?: string | undefined;
  DATABASE_CA_CERT_PATH?: string | undefined;
};

const invalidUrl = () => new ConfigurationError("DATABASE_URL is invalid");

/** No connectionString in production: pg cannot replace the explicit TLS policy. */
export const postgresPoolConfig = (
  config: DatabaseRuntimeConfig,
  max: number,
): PoolConfig => {
  if (config.DATABASE_URL === undefined) throw invalidUrl();
  if (config.NODE_ENV !== "production") {
    return { connectionString: config.DATABASE_URL, max };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ConfigurationError(
      "Insecure global TLS configuration is forbidden",
    );
  }
  let endpoint: Pick<
    PoolConfig,
    | "host"
    | "port"
    | "user"
    | "password"
    | "database"
    | "options"
    | "application_name"
  >;
  try {
    const url = new URL(config.DATABASE_URL);
    const port = url.port === "" ? 5432 : Number(url.port);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      host === "" ||
      host.includes("/") ||
      host.includes("%") ||
      url.username === "" ||
      url.password === "" ||
      url.pathname.length < 2 ||
      url.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      host.endsWith(".pooler.supabase.com") ||
      [...url.searchParams.keys()].some(
        (key) => !["options", "application_name"].includes(key),
      )
    )
      throw invalidUrl();
    endpoint = {
      host,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ...(url.searchParams.has("options")
        ? { options: url.searchParams.get("options") ?? "" }
        : {}),
      ...(url.searchParams.has("application_name")
        ? { application_name: url.searchParams.get("application_name") ?? "" }
        : {}),
    };
  } catch {
    // Do not retain URL parser errors: they can contain database credentials.
    throw invalidUrl();
  }

  let ca: string;
  try {
    ca = readFileSync(
      config.DATABASE_CA_CERT_PATH ??
        new URL("../certs/supabase-root-2021.crt", import.meta.url),
      "utf8",
    );
    if (
      !/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(
        ca,
      ) ||
      (ca.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0) !== 1
    ) {
      throw new Error("INVALID_CA_PEM");
    }
    const certificate = new X509Certificate(ca);
    if (
      !certificate.ca ||
      !certificate.verify(certificate.publicKey) ||
      Date.parse(certificate.validFrom) > Date.now() ||
      Date.parse(certificate.validTo) <= Date.now()
    ) {
      throw new Error("INVALID_ROOT_CA");
    }
    createSecureContext({ ca });
  } catch {
    throw new ConfigurationError(
      "Database TLS Root CA is missing, invalid or expired",
    );
  }
  const hostname = endpoint.host;
  if (hostname === undefined) throw invalidUrl();
  return {
    ...endpoint,
    max,
    ssl: {
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(hostname, certificate),
    },
  };
};
