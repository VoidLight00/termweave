# Contributing

TermWeave is an independent MIT-licensed derivative. Keep upstream copyright/notices and document provenance for every adapted dependency or asset. Do not import cmux GPL/BUSL code or branding into this project.

Use synthetic data only in issues, screenshots and tests. Security vulnerabilities belong in private reporting, not public issues. Explain the requirement, implementation scope, commands, exact source identity and limitations in your PR.

```sh
bun install --frozen-lockfile --ignore-scripts
bun scripts/verify-isolated.ts ledger type build unit render source-style
```

Native/browser product lanes require a separately installed compatible herdr runtime and Chromium. Use the owned isolated verifier; never point tests at existing user sockets. Linux/native CI approval and real-device manual checks remain UNKNOWN until executed.

Every UI key requires Korean, Simplified Chinese and Japanese translations with matching placeholders. Test long labels and keyboard accessibility. Contributions must not add credentials, personal transcripts, unreviewed binary assets, remote execution, automatic deployments or broad filesystem deletion.

External PR checks use read-only tokens, no secrets and no self-hosted personal runner. Do not execute contributed code under pull_request_target. Releases and upstream updates require independent review; a green source check is not public safety clearance.
