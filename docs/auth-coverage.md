# Authentication coverage map

- `server/access.test.ts`: unauthenticated external/proxy refusal, token precedence, forged Tailscale/host/proxy headers, loopback recovery.
- `server/product-auth.test.ts`: independent upstream/TermWeave cookies, logout coexistence, HTTPS proxy Secure/HttpOnly/SameSite cookies, invalid external access.
- `server/devices.test.ts`: pairing one-use, 10-minute expiry, wrong-attempt bound, hash-only registry, rename/revoke/write-failure recovery.
- `server/device-access.contract.test.ts`: observe mutation/file restrictions, active terminal/roster revocation, push revocation, persistence failure.
- `server/api.contract.test.ts`: authenticated/invalid cookie/bearer/API/WebSocket, proxy/origin checks and device lifecycle.

These run in owned isolated HOME/state/socket, using synthetic credentials. No genuine secrets or user terminal recordings are published. Exhaustive log redaction and real reverse-proxy deployment validation remain manual/review limits; tests do not certify every transport or hosting topology. Fragment login risk is documented in SECURITY.
