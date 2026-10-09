---
tags: [AI, TermWeave, Android]
source_type: ai
created: 2026-10-09T02:14:46.906747+09:00
saved: 2026-10-09T02:57:59.361624+09:00
timezone: Asia/Seoul
---

# TermWeave mobile relay operations

This service binds only `127.0.0.1:7339`. It has no TermWeave terminal or admin routes. Permanent device and viewer credentials are distinct 256-bit random values in mode-0600 private files. They are never CLI arguments or command output.

```sh
python3 tools/mobile-relay/manage.py start
python3 tools/mobile-relay/manage.py status
python3 tools/mobile-relay/manage.py pair
python3 tools/mobile-relay/manage.py revoke
python3 tools/mobile-relay/manage.py stop
```

`pair` intentionally displays a short-lived 12-character code, not a permanent credential. It expires after five minutes, can be redeemed once, and allows at most five valid-shape failed attempts. The Android app enters the HTTPS relay origin and this code, then obtains its device credential over HTTPS into memory. Android screen-share and accessibility permissions still require on-device approval. The app never saves the credential.

`revoke` records revocation durably and stops the owned process. A later `start` does not restore the enrollment. `rotate` explicitly replaces credentials and starts a fresh 24-hour enrollment. Existing gateway configuration must then be updated privately.

`install` installs `com.termweave.mobile-relay` as a user LaunchAgent. `uninstall` removes only that service. Process stop uses recorded PID, exact script/state arguments and process start time; it never runs a broad kill command.

## External access preparation

`prepare-tunnel` prints a command without running it. Cloudflared 2025.8.0 was identified through Homebrew metadata (Apache-2.0). Cloudflare documents WebSocket support on all plans. Its Quick Tunnel is temporary development access, not production hosting.

```sh
python3 tools/mobile-relay/manage.py prepare-tunnel
# Only after external publication is approved:
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:7339
```

The tunnel exposes only `/pair`, `/connect` and minimal `/health`. Device/viewer credentials still protect WebSocket connections. Pairing codes do not go in the URL. TLS terminates at the tunnel provider and at the local relay; application-level end-to-end media encryption is not implemented.

After a real HTTPS origin exists, `configure-viewer --public-origin https://... --app-state-dir <TermWeave state directory>` writes the viewer configuration privately. It emits no key. Reload or restart the gateway after that write. The origin must have no userinfo, path, query or fragment.

## Evidence boundary

Local lifecycle, persistent revocation, foreign-PID refusal, one-use pairing, APK build and authenticated socket forwarding are tested. External publication, phone installation, LTE media/control, and LaunchAgent activation are separate evidence states. No external tunnel was started by this implementation task.

Official sources:
- https://developers.cloudflare.com/network/websockets/
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://developer.android.com/media/grow/media-projection

## Approved temporary tunnel and APK delivery

After explicit external-access approval, `python3 tools/mobile-relay/tunnel.py start` opens only relay port 7339. `status` reports the public origin, and `stop` checks both PID creation time and exact command before terminating the owned process. State and logs remain private. No app admin port is exposed. Quick Tunnel hostnames are temporary.

The relay can serve exactly `GET /download/termweave-companion.apk` when its private `apk.json` is present. The manifest records the fixed APK path, SHA-256, and size. Startup checks file ownership, immutable bytes, and Android signature verification. Files are bounded to 32 MiB; four concurrent downloads are allowed. Query parameters, alternate filenames, ranges, and non-GET methods are refused. Directory browsing is not implemented. The current build is a signed debug pilot, not a store release.

The user installs the APK, enters the HTTPS relay origin, and then uses a newly issued single-use pairing code. Issue the five-minute code only when the phone is ready. The phone must explicitly approve screen sharing and separately enable the accessibility service for input. Successful relay health or APK download does not prove physical LTE screen sharing or input.
