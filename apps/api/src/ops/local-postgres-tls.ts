// Test-only PostgreSQL SSLRequest endpoint. TLS terminates locally, then forwards
// to the existing plaintext local DB; never accepts an arbitrary upstream host.
// Ephemeral keys stay outside the checkout/image. Production has no TLS bypass.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const localPostgresTls = async (
  input: string,
  container = false,
  wrongHostname = false,
) => {
  const upstreamUrl = new URL(input);
  if (upstreamUrl.hostname !== "127.0.0.1" || upstreamUrl.port !== "54322") {
    throw new Error("TLS_FIXTURE_ONLY_LOCAL_POSTGRES_ALLOWED");
  }
  const directory = await mkdtemp(join(tmpdir(), "hq-local-tls-"));
  const caPath = join(directory, "local-ca.crt");
  const keyPath = join(directory, "local-key.pem");
  const sockets = new Set<Socket>();
  const errors: string[] = [];
  const server = createServer();
  const cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
    // Exact generated directory, never supplied by an operator or environment.
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const opensslConfig = join(directory, "openssl.cnf");
    await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
    await exec(
      process.platform === "win32"
        ? "C:/Program Files/Git/usr/bin/openssl.exe"
        : "openssl",
      [
        "req",
        "-config",
        opensslConfig,
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        caPath,
        "-subj",
        "/CN=HQ local test CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-addext",
        wrongHostname
          ? "subjectAltName=DNS:wrong.example"
          : "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1",
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    const context = createSecureContext({
      key: await readFile(keyPath),
      cert: await readFile(caPath),
    });
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", (error: NodeJS.ErrnoException) =>
        errors.push(error.code ?? "TLS_FIXTURE_SOCKET_ERROR"),
      );
      return socket;
    };
    server.on("connection", (socket) => {
      track(socket);
      let request = Buffer.alloc(0);
      const negotiate = (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (request.length < 8) return;
        socket.off("data", negotiate);
        if (
          request.length !== 8 ||
          request.readUInt32BE(0) !== 8 ||
          request.readUInt32BE(4) !== 80877103
        ) {
          errors.push("TLS_REQUIRED");
          socket.destroy();
          return;
        }
        socket.write("S");
        const secure = track(
          new TLSSocket(socket, { isServer: true, secureContext: context }),
        );
        secure.once("secure", () => {
          const upstream = track(connect({ host: "127.0.0.1", port: 54322 }));
          secure.pipe(upstream).pipe(secure);
          secure.once("close", () => upstream.destroy());
          upstream.once("close", () => secure.destroy());
        });
      };
      socket.on("data", negotiate);
    });
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, container ? "0.0.0.0" : "127.0.0.1", done);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TLS_FIXTURE_PORT_MISSING");
    return {
      caPath,
      errors,
      cleanup,
      url: (source: string, inContainer = false) => {
        const url = new URL(source);
        if (url.hostname !== "127.0.0.1" || url.port !== "54322")
          throw new Error("TLS_FIXTURE_URL_NOT_LOCAL");
        url.hostname = inContainer ? "host.docker.internal" : "127.0.0.1";
        url.port = String(address.port);
        return url.toString();
      },
    };
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
};
