# Security

TermWeave exposes interactive terminals to authenticated browsers. Test only systems you own or are explicitly authorized to test.

Report vulnerabilities privately using the repository's private vulnerability reporting when enabled. Do not post tokens, cookies, pairing codes, transcripts or exploit details in public issues. No response-time SLA is promised.

Default bind is loopback. Non-local and proxy access requires a valid token or paired device; unauthenticated external access is denied, not a supported open mode. Observe-only devices must not mutate terminals. External exposure and proxy setup are opt-in and require review.

Inherited source auto-updates and default remote runtime downloads are disabled for this source release. Immutable release activation requires independent compatibility/health checks and separate operational approval. Native herdr, browser and provider vulnerabilities should also be reported to their respective upstreams.

Fragment login links can leak through copying, browser extensions or screenshots; prefer device pairing and never share live credentials in diagnostics.
