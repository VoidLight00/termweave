# Agent identity marks

Terminal marks use the native pane's `agent` field. They do not infer a provider from the user-editable terminal name or from the selected model. Each mark includes an accessible name and a hover title. A terminal running Claude Code through a different model provider remains identified as Claude Code.

The registered Herdr 0.9.1 catalog contains 24 kinds: agy, amp, claude, cline, codex, cursor, devin, droid, gemini, copilot, grok, hermes, kilo, kimi, kiro, letta, maki, muse, omp, omo, opencode, pi, qodercli and qwen. The existing GJC integration is also supported. Shells use a terminal icon. Unknown names retain their reported name with a generic agent icon and are never assigned another provider's logo.

## Provenance

The existing provider SVG components and static SVG bodies come from [Herdr Web UI](https://github.com/devswha/herdr-web-ui), revision `6bcb9bca4980b5a21b563dafac805a6a6c39ed61`, under its MIT license (copyright 2026 devswha). The original SVG catalog credits Lobe Icons (MIT), Factory's favicon and maki.sh's favicon; Muse is represented by the upstream catalog's Meta mark. Keep these attributions with redistributions. Brand marks identify their respective tools and do not imply endorsement or ownership by TermWeave.

The Letta mark is the public avatar of the verified [letta-ai organization](https://github.com/letta-ai), saved locally as `public/icons/letta.png`. SHA-256: `4c865f30b516828bdae8beaa2639fd1fe127fb35c2f235108ab3eadddb94783c`. It is used only to identify Letta Code; the surrounding application's MIT license does not relicense the trademark.

## Verification

`src/components/AgentMark.test.ts` covers all registered kinds, normalization, unknown names including prototype-property strings, distinct SVG definition IDs across repeated marks, and exclusion of executable/external SVG payloads. The production pane catalog and displayed logos are compared separately during release validation. Testing a rendered logo does not prove that every provider is installed or authenticated.
