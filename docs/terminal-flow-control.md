# Terminal output control and the Bun PTY comparison

Checked on 2026-09-22: Linux x64, Bun 1.4.2, Node 24.18.0, node-pty 1.1.0, xterm 5.5.0, herdr 0.9.0. Since 2026-09-26 node-pty comes as `@lydell/node-pty` 1.1.0, the same code with a prebuilt binary per platform, so nothing compiles at install.

## Decision

Keep xterm and the Node PTY sidecar. Bun.Terminal successfully handled the tested interactive operations and real herdr attaches, but its public API has no output `pause()`/`resume()`. Its `drain` callback concerns `terminal.write()` input, not consumption of child output. Removing node-pty would remove the upstream read control used below. Do not substitute `unref()` or suspend the whole attach process: input, including Ctrl+C, must remain live.

This corrects the previous statement that Bun had no PTY API. [Bun.Terminal was introduced in 1.3.5](https://bun.com/blog/bun-v1.3.5). See the [current API](https://bun.com/reference/bun/Terminal) and [xterm flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/). Revisit migration when native output control is available, or after validating another bounded, lossless approach. WebGL remains a separate rendering experiment.

## Implemented behavior

1. The browser attaches with `flow_control: "ack"`. Each subscription gets a fresh `stream_id`; each `pty-data.flow.offset` counts cumulative UTF-8 payload bytes, including the initial replay.
2. Only xterm's `write(data, callback)` callback sends `pty-ack`. This acknowledges parsing, not painting. Callbacks capture both the connection and pane subscription, so stale callbacks cannot acknowledge a new attach. ACKs are never queued while disconnected.
3. At 256 KiB outstanding, pause PTY reads. Resume when all remaining consumers are below their application watermark (<=64 KiB) and their transport queues have room. Input and resize remain available while output is paused.
4. A client blocked for 2 seconds is closed with code 4008 and removed from all attachments, releasing healthy peers. There is a 1 MiB hard payload budget per ACK subscription and a separate 1 MiB WebSocket transport budget, including JSON escaping. Already-read pipe data can arrive after pausing; the hard budget covers that overshoot.
5. The browser shows an overload notice and a Reconnect link, and does not automatically reconnect into another overload. The link reloads the selected pane with a fresh terminal; switching panes also reconnects. A new attach waits for the retiring process to release herdr's attach slot. The original herdr pane is not killed.
6. The sidecar also honors `stdout.write() === false` and `drain`. This gate and the browser pause gate must both clear to resume. The parent consumes the final stdout bytes before reporting process exit; terminating a paused sidecar resumes its reader to observe EOF and bounds forced cleanup.

`send() === -1` means Bun already queued the frame; resending would duplicate terminal bytes. A failed delivery stops the connection. Duplicate attaches no longer replay bytes twice. Duplicate, stale or out-of-order ACKs cannot release additional credit; future/non-integer offsets in the active subscription receive `invalid_ack`. Observers can ACK but still cannot type or resize.

Clients without `flow_control` retain wire compatibility and the transport cap, but have no xterm parser credit. Reload an older browser client to use the complete path.

The 256 KiB replay tail now counts UTF-8 bytes and avoids splitting a code point. It is still a stream tail, not a serialized terminal snapshot: arbitrary ANSI state cannot be reconstructed reliably from every possible tail. Overload does not silently discard chunks and continue displaying a supposedly complete live stream. Ordinary/manual reattachment retains the existing replay limitation.

## Verification and comparison

Reproduce using only newly created `herdr-web-ui-test-*` workspaces:

```sh
bun test server/pty/session.test.ts server/output-window.test.ts server/output.contract.test.ts
bun scripts/pty-compare.ts 30
bun run build
bun scripts/output-browser-qa.ts
bun scripts/ui-regression.ts
```

The comparison script's native adapter is experimental and is never selected by the server. Both backends passed TTY detection, Korean/emoji input, resize, Ctrl+C input, final output, exit-code reporting, a real `herdr terminal attach`, and attach-process cleanup. Each then streamed 49,152,000 bytes of Korean/emoji output over roughly 30 seconds; SHA-256 and byte counts matched exactly.

| One comparison run | Node sidecar | Bun.Terminal |
|---|---:|---:|
| Interactive startup | 51 ms | 21 ms |
| Ctrl+C response, polled every 10 ms | 10 ms | 10 ms |
| Sustained-output elapsed time | 30,632 ms | 32,104 ms |
| Sampled peak process-tree RSS | 167,204 KiB | 105,384 KiB |
| Output read pause/resume available | Yes | No |

RSS includes the comparison runner and producer, plus the Node host for the sidecar case. The same runner executes the cases sequentially; warm-up, garbage collection and other machine activity were not controlled. These are one-run observations, not a general performance ranking, a leak verdict or a multi-hour soak test.

The contract tests use real herdr redraw traffic to verify stalled-observer eviction, bounded outstanding bytes, operator continuation, live Ctrl+C input, stale ACK rejection and valid-ACK resumption. PTY tests separately verify split UTF-8, final multi-megabyte output before exit, paused output with working input, and cleanup while paused. Browser QA drives the real built UI and xterm, withholding only outgoing ACKs to verify the notice, absence of an automatic reconnect loop, and recovery by pane selection. Test workspaces and servers are cleaned up.

During validation, a pre-existing local node-pty binary linked against the system `libnode.so.109` crashed at shutdown under the active Node 24 runtime. Rebuilding with the active Node installation's bundled node-gyp and matching headers removed that linkage and the crash. The distro node-gyp build reintroduced the bad linkage. On a similar mixed installation, inspect `ldd node_modules/node-pty/build/Release/pty.node` and rebuild with the toolchain belonging to the Node executable that runs the sidecar. This applied to the compiled node-pty; the prebuilt distribution installs no toolchain and never runs node-gyp, so a normal install cannot hit it.
