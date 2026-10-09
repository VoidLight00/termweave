import { expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark } from "./AgentMark.tsx";

// Native Herdr 0.9.1 /api/agents catalog, plus the existing GJC integration.
const agents = ["agy", "amp", "claude", "cline", "codex", "cursor", "devin", "droid", "gemini", "copilot", "grok", "hermes", "kilo", "kimi", "kiro", "letta", "maki", "muse", "omp", "omo", "opencode", "pi", "qodercli", "qwen", "gjc"];
test("each registered native agent has a named mark without an initial-only fallback", () => {
  for (const agent of agents) {
    const html = renderToStaticMarkup(createElement(AgentMark, { agent }));
    expect(html).toContain('data-agent-mark="recognized"');
    expect(html).toContain(`data-agent="${agent}"`);
    expect(html).toMatch(/aria-label="[^"]+"/);
    expect(html).not.toContain("<text");
    expect(html).not.toContain("lucide-bot");
    expect(html).toMatch(agent === "letta" ? /src="\/icons\/letta.png"/ : /<svg/);
  }
});
test("normalization and unknown agents never impersonate another provider", () => {
  expect(renderToStaticMarkup(createElement(AgentMark, { agent: " ClaudeCode " }))).toContain('aria-label="Claude Code"');
  expect(renderToStaticMarkup(createElement(AgentMark, { agent: "CODEX" }))).toContain('aria-label="Codex"');
  for (const agent of ["unknown-tool", "constructor", "__proto__"]) {
    const html = renderToStaticMarkup(createElement(AgentMark, { agent }));
    expect(html).toContain('data-agent-mark="unknown"');
    expect(html).toContain(`aria-label="${agent}"`);
    expect(html).toContain("lucide-bot");
  }
  const shell = renderToStaticMarkup(createElement(AgentMark, { agent: "shell" }));
  expect(shell).toContain('aria-label="Shell"');
  expect(shell).toContain("lucide-terminal");
});
test("repeated marks have distinct gradient IDs and no external SVG payload", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, ...agents.flatMap(agent => [0, 1].map(n => createElement(AgentMark, { agent, key: `${agent}-${n}` })))));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html).not.toMatch(/<script|<foreignObject|javascript:|(?:href|src)="https?:/i);
});
