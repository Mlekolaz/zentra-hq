# Supabase public Root CA

`supabase-root-2021.crt` is the public Supabase Root 2021 CA, not a secret.
Source: [Supabase certificate distribution](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt).
Provider instructions: [Supabase verified TLS](https://supabase.com/docs/guides/platform/ssl-enforcement).
Downloaded through verified HTTPS; no project/database endpoint was contacted.

SHA-256 certificate fingerprint (DER):
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
Expires 2031-04-26 10:56:53 UTC. The fingerprint is asserted in local tests.

Production always verifies the CA chain and DATABASE_URL hostname. The CA is
bundled with workspace sources and readable by the non-root image user. An
explicit `DATABASE_CA_CERT_PATH` may select a reviewed replacement public root
file; there is no fetch-at-start, system-trust fallback or insecure TLS mode.
Monitor provider CA rotation and expiry; review any replacement, update this
file, fingerprint tests and image together. Never bundle a private key.
