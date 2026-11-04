#!/usr/bin/env bun
/**
 * Static guards of the Windows port (plan 5B). TS/TSX facts come from the TypeScript compiler API, install.ps1 facts from the
 * PowerShell AST ([System.Management.Automation.Language.Parser]::ParseFile in powershell/pwsh). Guards:
 *   lifecycle-env  every child-process spawn of the owned lifecycle gets its env only as a direct buildChildEnv(...) call
 *   input-path     composition -> term.onData -> sendData -> socket.sendInput -> {type:"input"} -> server case "input"
 *                  -> paneSendText(mirrorInput(message.text)) -> herdrRpc("pane.send_text")
 *   install-ps1    ASCII only (byte scan, needs no PowerShell); exit codes 0/1/2 and no Invoke-Expression/iex outside the child
 *                  installer (PowerShell AST only: without a PowerShell host off Windows these two report SKIP, never a regex guess)
 *   reuse-port     the server bind path (Bun.serve in server/index.ts) and no server module sets reusePort
 *   liveness       lifecycle-state decide() judges liveness from the bridge probe alone, never from full health
 * Usage: bun scripts/check-windows-invariants.mjs [--root DIR]   (exit 0 pass, 1 violation)
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const nodeIn = (root, rel) => join(root, ...rel.split('/'));
function source(root, rel) {
  const text = readFileSync(nodeIn(root, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
const at = (sf, node) => `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
function all(node, pred, out = []) { if (pred(node)) out.push(node); ts.forEachChild(node, (child) => { all(child, pred, out); }); return out; }
/** Nodes of `node`'s own body, not those inside a nested function. */
function direct(node, pred, out = []) { ts.forEachChild(node, (child) => { if (pred(child)) out.push(child); if (!ts.isFunctionLike(child)) direct(child, pred, out); }); return out; }
const nameOf = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node)) ? node.text : undefined;
const callee = (call) => { const e = call.expression; return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? `${e.expression.getText()}.${e.name.text}` : undefined; };
const isCallTo = (node, name) => ts.isCallExpression(node) && callee(node) === name;
const property = (object, name) => object.properties.find((p) => nameOf(p.name) === name);
/** Local names bound by `import {a as b}` from a module matching `from`. */
function imports(sf, from) {
  const named = new Map(); const namespaces = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !from.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause; if (!clause) continue;
    if (clause.name) namespaces.push(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.push(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) named.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  return { named, namespaces };
}
const localFor = (bound, imported) => [...bound.named].find(([, name]) => name === imported)?.[0];
/** `const name = <init>` declared anywhere in `scope`. */
const declared = (scope, name) => all(scope, (n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && !!n.initializer);
const unwrapAwait = (node) => node && ts.isAwaitExpression(node) ? node.expression : node;

// ---- lifecycle-env -------------------------------------------------------------------------------------------------------
export const BUILDER_MODULE = 'scripts/lifecycle-env.ts', BUILDER = 'buildChildEnv';
export const SPAWN_FILES = ['scripts/owned-install.ts', 'scripts/owned-server.ts', 'scripts/lifecycle-launch.ts', 'scripts/install-lifecycle.ts', BUILDER_MODULE];
const CHILD_PROCESS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
function lifecycleEnv(root, fail) {
  const builderFile = source(root, BUILDER_MODULE);
  const builder = builderFile.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === BUILDER && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  if (!builder) fail(`${BUILDER_MODULE} no longer exports function ${BUILDER}, the single child env builder`);
  let spawns = 0;
  for (const rel of SPAWN_FILES) {
    const sf = source(root, rel);
    const cp = imports(sf, /^(?:node:)?child_process$/);
    const builderLocal = rel === BUILDER_MODULE ? BUILDER : localFor(imports(sf, /^\.\/lifecycle-env(?:\.ts)?$/), BUILDER);
    const bunShell = localFor(imports(sf, /^bun$/), '$');
    for (const node of all(sf, () => true)) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && /child_process/.test(node.arguments[0]?.getText() ?? '')) { fail(`${at(sf, node)} requires child_process outside the checked imports`); continue; }
      if (ts.isTaggedTemplateExpression(node) && (node.tag.getText() === 'Bun.$' || node.tag.getText() === bunShell)) { fail(`${at(sf, node)} runs a Bun shell command, whose env bypasses ${BUILDER}`); continue; }
      if (!ts.isCallExpression(node)) continue;
      const e = node.expression; let kind;
      if (ts.isIdentifier(e) && CHILD_PROCESS.has(cp.named.get(e.text))) kind = cp.named.get(e.text);
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && cp.namespaces.includes(e.expression.text) && CHILD_PROCESS.has(e.name.text)) kind = e.name.text;
      else if (ts.isPropertyAccessExpression(e) && e.expression.getText() === 'Bun' && (e.name.text === 'spawn' || e.name.text === 'spawnSync')) kind = `Bun.${e.name.text}`;
      if (!kind) continue;
      spawns++;
      // Bun.spawn({cmd,...}) carries its options first; every other form after the command
      const candidates = kind.startsWith('Bun.') && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? [node.arguments[0]] : node.arguments.slice(1);
      const options = candidates.filter(ts.isObjectLiteralExpression).at(-1);
      if (!options) { fail(`${at(sf, node)} ${kind} has no options object: the child inherits the raw parent environment instead of ${BUILDER}(...)`); continue; }
      if (options.properties.some(ts.isSpreadAssignment)) { fail(`${at(sf, node)} ${kind} options spread another object, which can carry an env that bypasses ${BUILDER}`); continue; }
      const env = property(options, 'env');
      if (!env) { fail(`${at(sf, node)} ${kind} sets no env: the child inherits the raw parent environment instead of ${BUILDER}(...)`); continue; }
      const value = ts.isPropertyAssignment(env) ? env.initializer : undefined;
      if (!value || !ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== builderLocal)
        fail(`${at(sf, node)} ${kind} env is \`${(value ?? env).getText()}\`, not a direct ${BUILDER}(...) call from ${BUILDER_MODULE}`);
    }
  }
  if (!spawns) fail(`no child-process spawn found in ${SPAWN_FILES.join(', ')}: the guard checks nothing`);
}

// ---- input-path ----------------------------------------------------------------------------------------------------------
export const INPUT_FILES = { pane: 'src/components/PaneTerminal.tsx', ws: 'src/lib/ws.ts', server: 'server/index.ts', client: 'server/herdr/client.ts' };
function inputPath(root, fail) {
  // 1. PaneTerminal: composition events are tracked, WebKit IME edits re-enter xterm through term.input, xterm's onData
  //    (which also delivers committed composition text) hands everything to sendData, and sendData to socket.sendInput.
  const pane = source(root, INPUT_FILES.pane);
  const listened = new Set(all(pane, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'addEventListener').map((n) => nameOf(n.arguments[0])));
  for (const event of ['compositionstart', 'compositionend']) if (!listened.has(event)) fail(`${INPUT_FILES.pane} listens for no ${event}: composition is not tracked on the production path`);
  if (!all(pane, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'input' && n.arguments.length === 2 && n.arguments[1].kind === ts.SyntaxKind.TrueKeyword).length)
    fail(`${INPUT_FILES.pane} never calls term.input(edit, true): WebKit IME edits no longer reach xterm's onData`);
  const wsLocal = localFor(imports(pane, /^\.\.\/lib\/ws(?:\.ts)?$/), 'HerdrSocket');
  const socket = declared(pane, 'socket').find((d) => ts.isNewExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === wsLocal);
  if (!wsLocal || !socket) fail(`${INPUT_FILES.pane} creates no \`socket = new HerdrSocket(...)\` from ../lib/ws.ts`);
  const handlers = all(pane, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'onData' && !!n.arguments[0] && ts.isFunctionLike(n.arguments[0]));
  if (!handlers.some((h) => direct(h.arguments[0].body, (n) => isCallTo(n, 'sendData')).length)) fail(`${INPUT_FILES.pane} term.onData handler does not call sendData(data): typed and composed text never reaches the socket`);
  const sendData = declared(pane, 'sendData').find((d) => ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
  if (!sendData || !direct(sendData.initializer.body, (n) => isCallTo(n, 'socket.sendInput') && n.arguments.length === 2).length) fail(`${INPUT_FILES.pane} sendData does not call socket.sendInput(pane, input)`);
  // 2. ws.ts: HerdrSocket.sendInput puts {type:"input", pane_id, text} on the WebSocket.
  const ws = source(root, INPUT_FILES.ws);
  const herdrSocket = ws.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'HerdrSocket');
  const method = (name) => herdrSocket?.members.find((m) => ts.isMethodDeclaration(m) && nameOf(m.name) === name && m.body);
  const sendInput = method('sendInput'), rawSend = method('rawSend');
  const params = sendInput?.parameters.map((p) => p.name.getText()) ?? [];
  const frame = sendInput && all(sendInput.body, (n) => isCallTo(n, 'this.rawSend')).map((n) => n.arguments[0]).find((arg) => {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
    const type = property(arg, 'type'), id = property(arg, 'pane_id'), text = property(arg, 'text');
    const value = (p) => p && (ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? p.initializer.getText() : undefined);
    return type && ts.isPropertyAssignment(type) && nameOf(type.initializer) === 'input' && value(id) === params[0] && value(text) === params[1];
  });
  if (!frame) fail(`${INPUT_FILES.ws} HerdrSocket.sendInput(paneId, text) does not rawSend {type: "input", pane_id: paneId, text}`);
  if (!rawSend || !all(rawSend.body, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'send' && n.expression.expression.getText() === 'this.socket').length)
    fail(`${INPUT_FILES.ws} HerdrSocket.rawSend does not write to this.socket`);
  // 3. server: case "input" without a pty sends the mirror-shaped message.text through paneSendText.
  const server = source(root, INPUT_FILES.server);
  const sendText = localFor(imports(server, /^\.\/herdr\/client(?:\.ts)?$/), 'paneSendText');
  const shape = localFor(imports(server, /^\.\/mirror-input(?:\.ts)?$/), 'mirrorInput');
  if (!sendText) fail(`${INPUT_FILES.server} does not import paneSendText from ./herdr/client.ts`);
  if (!shape) fail(`${INPUT_FILES.server} does not import mirrorInput from ./mirror-input.ts`);
  const clauses = all(server, (n) => ts.isCaseClause(n) && nameOf(n.expression) === 'input' && n.parent.parent.expression.getText() === 'message.type');
  const isMessageText = (node, scope) => node && (node.getText() === 'message.text' || (ts.isIdentifier(node) && declared(scope, node.text).some((d) => d.initializer.getText() === 'message.text')));
  const shaped = clauses.some((clause) => all(clause, (n) => sendText && isCallTo(n, sendText) && n.arguments[0]?.getText() === 'message.pane_id' && ts.isIdentifier(n.arguments[1] ?? n)).some((call) =>
    declared(clause, call.arguments[1].text).some((d) => { const init = unwrapAwait(d.initializer); return ts.isCallExpression(init) && shape && isCallTo(init, shape) && isMessageText(init.arguments[0], clause); })));
  if (!clauses.length) fail(`${INPUT_FILES.server} has no \`case "input"\` in the switch on message.type`);
  else if (!shaped) fail(`${INPUT_FILES.server} case "input" never calls paneSendText(message.pane_id, shaped) with shaped = await mirrorInput(message.text, ...)`);
  // 4. herdr client: paneSendText is herdr's pane.send_text with the same pane and text.
  const client = source(root, INPUT_FILES.client);
  const fn = client.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'paneSendText' && s.body);
  const [paneParam, textParam] = fn?.parameters.map((p) => p.name.getText()) ?? [];
  const rpc = fn && all(fn.body, (n) => isCallTo(n, 'herdrRpc')).find((call) => {
    const [method, payload] = call.arguments;
    if (nameOf(method) !== 'pane.send_text' || !payload || !ts.isObjectLiteralExpression(payload)) return false;
    const value = (p) => p && (ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? p.initializer.getText() : undefined);
    return value(property(payload, 'pane_id')) === paneParam && value(property(payload, 'text')) === textParam;
  });
  if (!rpc) fail(`${INPUT_FILES.client} paneSendText(paneId, text) does not call herdrRpc("pane.send_text", {pane_id: paneId, text})`);
}

// ---- install-ps1 ---------------------------------------------------------------------------------------------------------
export const INSTALL_PS1 = 'install.ps1';
/** The child installer: the only place Invoke-Expression may appear (it runs the downloaded official installer script). */
export const CHILD_INSTALLER = 'ChildInstaller', CHILD_RUNNER = 'Invoke-OfficialInstaller';
/** A function whose return value is the exit code of a child that keeps the 0/1/2 contract itself (scripts/install-lifecycle.ts). */
export const PASSTHROUGH = { 'Invoke-Lifecycle': 'scripts\\install-lifecycle.ts' };
const PS_FACTS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$L = 'System.Management.Automation.Language.'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:TW_INVARIANT_PS_FILE, [ref]$tokens, [ref]$errors)
function Find($node, [string]$Type) { return @($node.FindAll({ param($n) $n.GetType().Name -eq $Type }, $true)) }
function Get-Fn($node) { for ($p = $node.Parent; $null -ne $p; $p = $p.Parent) { if ($p -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $p.Name } }; return '' }
function Get-Value($node) {
  if ($null -eq $node) { return @{ k = 'none' } }
  $type = $node.GetType().Name
  if ($type -eq 'PipelineAst' -and $node.PipelineElements.Count -eq 1) {
    $element = $node.PipelineElements[0]
    if ($element.GetType().Name -eq 'CommandExpressionAst') { return Get-Value $element.Expression }
    if ($element.GetType().Name -eq 'CommandAst') { return @{ k = 'call'; name = $element.GetCommandName(); text = $element.Extent.Text } }
  }
  if ($type -eq 'CommandExpressionAst') { return Get-Value $node.Expression }
  if ($type -eq 'ParenExpressionAst') { return Get-Value $node.Pipeline }
  if ($type -eq 'ConvertExpressionAst') { return @{ k = 'convert'; type = $node.Type.TypeName.FullName; child = (Get-Value $node.Child) } }
  if ($type -eq 'ConstantExpressionAst') { return @{ k = 'const'; value = $node.Value; text = $node.Extent.Text } }
  if ($type -eq 'VariableExpressionAst') { return @{ k = 'var'; name = $node.VariablePath.UserPath } }
  return @{ k = 'other'; text = $node.Extent.Text }
}
$facts = @{
  errors = @($errors | ForEach-Object { @{ line = $_.Extent.StartLineNumber; message = $_.Message } })
  commands = @(Find $ast 'CommandAst' | ForEach-Object { @{ name = $_.GetCommandName(); line = $_.Extent.StartLineNumber; fn = (Get-Fn $_); text = $_.Extent.Text } })
  exits = @(Find $ast 'ExitStatementAst' | ForEach-Object { @{ line = $_.Extent.StartLineNumber; fn = (Get-Fn $_); value = (Get-Value $_.Pipeline) } })
  returns = @(Find $ast 'ReturnStatementAst' | ForEach-Object { @{ line = $_.Extent.StartLineNumber; fn = (Get-Fn $_); value = (Get-Value $_.Pipeline) } })
  assignments = @(Find $ast 'AssignmentStatementAst' | Where-Object { $_.Left.GetType().Name -eq 'VariableExpressionAst' } | ForEach-Object { @{ line = $_.Extent.StartLineNumber; fn = (Get-Fn $_); name = $_.Left.VariablePath.UserPath; operator = $_.Operator.ToString(); value = (Get-Value $_.Right); quoting = $(if ($_.Right.GetType().Name -eq 'CommandExpressionAst' -and $_.Right.Expression.GetType().Name -eq 'StringConstantExpressionAst') { $_.Right.Expression.StringConstantType.ToString() } else { '' }) } })
  variables = @(Find $ast 'VariableExpressionAst' | ForEach-Object { @{ name = $_.VariablePath.UserPath; line = $_.Extent.StartLineNumber; fn = (Get-Fn $_); assigned = ($_.Parent.GetType().Name -eq 'AssignmentStatementAst' -and [object]::ReferenceEquals($_.Parent.Left, $_)); parent = $_.Parent.Extent.Text } })
  functions = @(Find $ast 'FunctionDefinitionAst' | ForEach-Object { @{ name = $_.Name; line = $_.Extent.StartLineNumber; text = $_.Extent.Text } })
}
$facts | ConvertTo-Json -Depth 12 -Compress
`;
/** powershell.exe on Windows, else pwsh; undefined when neither is on PATH. */
export const powershellHost = () => Bun.which('powershell') ?? Bun.which('pwsh') ?? undefined;
function powershellFacts(host, file) {
  const result = Bun.spawnSync([host, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_FACTS, 'utf16le').toString('base64')], { env: { ...process.env, TW_INVARIANT_PS_FILE: file }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${host} could not parse ${file} (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString());
}
const describe = (v) => v.k === 'call' ? v.text : v.k === 'convert' ? `[${v.type}]${describe(v.child)}` : v.k === 'var' ? `$${v.name}` : v.k === 'none' ? '(nothing)' : String(v.text);
function installPs1(root, fail, skip) {
  const host = powershellHost();
  const bytes = readFileSync(nodeIn(root, INSTALL_PS1));
  const offset = bytes.findIndex((b) => b > 0x7f);
  if (offset >= 0) fail(`${INSTALL_PS1}:${bytes.subarray(0, offset).toString('latin1').split('\n').length} has a non-ASCII byte 0x${bytes[offset].toString(16)} at offset ${offset}; Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page`);
  if (!host) {
    if (process.platform === 'win32') fail('no powershell or pwsh on PATH: the install.ps1 AST guards cannot run');
    else skip(`${INSTALL_PS1} exit codes and Invoke-Expression: no powershell/pwsh on PATH (PowerShell AST only, no regex fallback)`);
    return;
  }
  const facts = powershellFacts(host, nodeIn(root, INSTALL_PS1));
  for (const error of facts.errors) fail(`${INSTALL_PS1}:${error.line} does not parse: ${error.message}`);
  // Invoke-Expression: none in this script's own AST. The child installer is a single-quoted here-string (data to this parser,
  // never expanded), assigned once at script scope and read only by Invoke-OfficialInstaller, which hands it Base64-encoded to a
  // separate `powershell.exe -NoProfile -EncodedCommand`; its iex of the downloaded official installer runs there, not here.
  for (const command of facts.commands) if (/^(?:invoke-expression|iex)$/i.test(command.name ?? '')) fail(`${INSTALL_PS1}:${command.line} runs Invoke-Expression outside the child installer here-string ($${CHILD_INSTALLER}): ${command.text}`);
  const child = facts.assignments.filter((a) => a.name === CHILD_INSTALLER);
  if (child.length !== 1 || child[0].fn !== '' || child[0].quoting !== 'SingleQuotedHereString') fail(`${INSTALL_PS1}: $${CHILD_INSTALLER} must be assigned exactly once, at script scope, from a single-quoted here-string`);
  for (const use of facts.variables.filter((v) => v.name === CHILD_INSTALLER && !v.assigned))
    if (use.fn !== CHILD_RUNNER || !/^\[Text\.Encoding\]::Unicode\.GetBytes\(\$ChildInstaller\)$/i.test(use.parent)) fail(`${INSTALL_PS1}:${use.line} reads $${CHILD_INSTALLER} outside ${CHILD_RUNNER}'s -EncodedCommand encoding: ${use.parent}`);
  if (!facts.commands.some((c) => c.fn === CHILD_RUNNER && c.name === 'Start-Child' && /'-EncodedCommand',\s*\$encoded/.test(c.text) && /powershell\.exe/i.test(facts.functions.find((f) => f.name === CHILD_RUNNER)?.text ?? '')))
    fail(`${INSTALL_PS1}: ${CHILD_RUNNER} no longer runs the child installer in a separate powershell.exe -EncodedCommand`);
  // Exit codes: every `exit` value, followed through variables (their assignments in the same scope) and calls of this script's
  // functions (their `return` values), must end in a literal 0, 1 or 2 or in a PASSTHROUGH function.
  const functions = new Set(facts.functions.map((f) => f.name));
  for (const [name, entry] of Object.entries(PASSTHROUGH)) {
    const text = facts.functions.find((f) => f.name === name)?.text ?? '';
    const returns = facts.returns.filter((r) => r.fn === name);
    if (!text.includes(entry) || !returns.length || returns.some((r) => r.value.k !== 'call' || r.value.name !== 'Wait-Child')) fail(`${INSTALL_PS1}: ${name} must return Wait-Child of ${entry} (its 0/1/2 exit code passes through)`);
  }
  const memo = new Map();
  const codes = (value, fn, path) => {
    if (value.k === 'const') return typeof value.value === 'number' && [0, 1, 2].includes(value.value) ? [] : [`${value.text} is not 0, 1 or 2`];
    if (value.k === 'convert') return /^int(?:32)?$/i.test(value.type) ? codes(value.child, fn, path) : [`${describe(value)} is not an [int] code`];
    if (value.k === 'var') {
      const sources = facts.assignments.filter((a) => a.name.toLowerCase() === value.name.toLowerCase() && a.fn === fn);
      if (!sources.length) return [`$${value.name} has no assignment in ${fn || 'script scope'}`];
      return sources.flatMap((a) => a.operator !== 'Equals' ? [`$${value.name} is changed with ${a.operator} at line ${a.line}`] : codes(a.value, fn, path));
    }
    if (value.k === 'call' && value.name in PASSTHROUGH) return [];
    if (value.k === 'call' && functions.has(value.name)) {
      if (path.includes(value.name)) return [];
      if (!memo.has(value.name)) {
        const returns = facts.returns.filter((r) => r.fn === value.name);
        memo.set(value.name, returns.length ? returns.flatMap((r) => codes(r.value, value.name, [...path, value.name]).map((why) => `${value.name} line ${r.line}: ${why}`)) : [`${value.name} returns no exit code`]);
      }
      return memo.get(value.name);
    }
    return [`${describe(value)} is not a literal code, a variable or a call of this script's functions`];
  };
  if (!facts.exits.length) fail(`${INSTALL_PS1} has no exit statement: its exit code is not set explicitly`);
  for (const exit of facts.exits) {
    // a bare `exit` is exit code 0
    const why = exit.value.k === 'none' ? [] : codes(exit.value, exit.fn, exit.fn ? [exit.fn] : []);
    for (const reason of new Set(why)) fail(`${INSTALL_PS1}:${exit.line} exit code outside 0/1/2: ${reason}`);
  }
}

// ---- reuse-port ----------------------------------------------------------------------------------------------------------
export const BIND_FILE = 'server/index.ts';
function reusePort(root, fail) {
  const sf = source(root, BIND_FILE);
  const serves = all(sf, (n) => ts.isCallExpression(n) && callee(n) === 'Bun.serve');
  if (!serves.length) fail(`${BIND_FILE} has no Bun.serve call: the bind path moved and this guard checks nothing`);
  for (const call of serves) {
    const options = call.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) fail(`${at(sf, call)} Bun.serve options are not an object literal, so reusePort cannot be ruled out`);
    else if (options.properties.some(ts.isSpreadAssignment)) fail(`${at(sf, call)} Bun.serve options spread another object, which can carry reusePort`);
  }
  const files = [];
  const visit = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== 'node_modules') visit(path); } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(relative(root, path).split(sep).join('/')); } };
  visit(nodeIn(root, 'server'));
  for (const rel of [...files, 'scripts/owned-server.ts']) {
    const file = source(root, rel);
    for (const node of all(file, (n) => (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isPropertyAccessExpression(n)) && nameOf(n.name) === 'reusePort'))
      fail(`${at(file, node)} sets reusePort: on Windows a second server could share the bridge port`);
  }
}

// ---- liveness ------------------------------------------------------------------------------------------------------------
export const STATE_FILE = 'scripts/lifecycle-state.ts', LIFECYCLE_FILE = 'scripts/install-lifecycle.ts', LAUNCH_FILE = 'scripts/lifecycle-launch.ts';
const HEALTH = /health/i;
function liveness(root, fail) {
  const sf = source(root, STATE_FILE);
  const alias = (name) => sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  const decide = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'decide' && s.body);
  if (!decide) { fail(`${STATE_FILE} has no function decide`); return; }
  const [param, ...extra] = decide.parameters;
  if (!param || extra.length || param.type?.getText() !== 'Observation') fail(`${at(sf, decide)} decide must take exactly one Observation`);
  const observation = alias('Observation'), probe = alias('Probe');
  if (!observation || !ts.isTypeLiteralNode(observation.type)) fail(`${STATE_FILE} Observation is not an object type`);
  else {
    const probeMember = observation.type.members.find((m) => nameOf(m.name) === 'probe');
    if (probeMember?.type?.getText() !== 'Probe') fail(`${at(sf, observation)} Observation.probe must be the bridge Probe`);
    for (const member of observation.type.members) if (HEALTH.test(member.getText()) || nameOf(member.name) === 'ok') fail(`${at(sf, member)} Observation carries full health: ${member.getText()}`);
  }
  const members = probe && ts.isUnionTypeNode(probe.type) && probe.type.types.every(ts.isTypeLiteralNode) ? probe.type.types.flatMap((t) => t.members.map((m) => nameOf(m.name))) : undefined;
  if (!members || members.some((name) => name !== 'kind' && name !== 'boot_id')) fail(`${STATE_FILE} Probe must be the bridge answer only ({kind:'boot';boot_id} | {kind:'silent'})`);
  const o = param && ts.isIdentifier(param.name) ? param.name.text : 'o';
  for (const node of all(decide.body, (n) => (ts.isIdentifier(n) && HEALTH.test(n.text)) || (ts.isPropertyAccessExpression(n) && n.name.text === 'ok')))
    fail(`${at(sf, node)} decide reads full health (${node.getText()}); liveness must come from the bridge probe alone`);
  if (!all(decide.body, (n) => ts.isPropertyAccessExpression(n) && n.expression.getText() === o && n.name.text === 'probe').length) fail(`${at(sf, decide)} decide never reads ${o}.probe: liveness is not judged from the bridge probe`);
  // Callers: a probe handed to decide is the bridge probe of the same function, and nothing health-shaped rides along.
  const lifecycle = source(root, LIFECYCLE_FILE);
  const decideLocal = localFor(imports(lifecycle, /^\.\/lifecycle-state(?:\.ts)?$/), 'decide');
  const calls = decideLocal ? all(lifecycle, (n) => isCallTo(n, decideLocal)) : [];
  if (!calls.length) fail(`${LIFECYCLE_FILE} never calls decide from ./lifecycle-state.ts`);
  for (const call of calls) {
    let scope = call.parent; while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    for (const node of all(scope ?? lifecycle, (n) => ts.isIdentifier(n) && HEALTH.test(n.text))) fail(`${at(lifecycle, node)} the function that calls decide reads full health (${node.getText()})`);
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (ts.isSpreadAssignment(p)) continue;
      if (HEALTH.test(p.getText())) fail(`${at(lifecycle, p)} decide gets full health: ${p.getText()}`);
      if (nameOf(p.name) !== 'probe') continue;
      const value = ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? p.initializer : undefined;
      const fromBridge = value && ts.isIdentifier(value) && declared(scope ?? lifecycle, value.text).some((d) => { const init = unwrapAwait(d.initializer); return ts.isCallExpression(init) && isCallTo(init, 'bridgeProbe'); });
      if (!fromBridge) fail(`${at(lifecycle, p)} decide gets a probe that is not \`await bridgeProbe(...)\`: ${p.getText()}`);
    }
  }
  const launch = source(root, LAUNCH_FILE);
  const bridge = launch.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'bridgeProbe' && s.body);
  if (!bridge || !all(bridge.body, (n) => isCallTo(n, 'fetch') && /\/api\/health\?scope=bridge`?$/.test(n.arguments[0]?.getText() ?? '')).length) fail(`${LAUNCH_FILE} bridgeProbe does not fetch the bridge-only /api/health?scope=bridge`);
}

// ---- runner --------------------------------------------------------------------------------------------------------------
export const GUARDS = { 'lifecycle-env': lifecycleEnv, 'input-path': inputPath, 'install-ps1': installPs1, 'reuse-port': reusePort, liveness };
/** Runs the guards (all, or `only`) on the tree at `root`. Failures and skips are `[guard] message` lines; a guard that throws is a failure. */
export function checkInvariants(root, { only = Object.keys(GUARDS) } = {}) {
  const failures = [], skips = [], passed = [];
  for (const name of only) {
    const guard = GUARDS[name]; if (!guard) throw new Error(`Unknown guard: ${name}`);
    const before = failures.length;
    const fail = (message) => failures.push(`[${name}] ${message}`), skip = (message) => skips.push(`[${name}] ${message}`);
    try { guard(root, fail, skip); }
    catch (error) { fail(`cannot check: ${error instanceof Error ? error.message : String(error)}`); }
    if (failures.length === before) passed.push(name);
  }
  return { failures, skips, passed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root')) { console.error('Usage: bun scripts/check-windows-invariants.mjs [--root DIR]'); process.exit(1); }
  const root = resolve(args[1] ?? join(import.meta.dir, '..'));
  if (!existsSync(root)) { console.error(`FAIL[windows-invariants] no such root: ${root}`); process.exit(1); }
  const { failures, skips, passed } = checkInvariants(root);
  for (const line of skips) console.log(`SKIP${line}`);
  for (const line of failures) console.error(`FAIL${line}`);
  console.log(`${failures.length ? 'FAIL' : 'PASS'}[windows-invariants] ${passed.length} of ${Object.keys(GUARDS).length} guards passed (${passed.join(', ') || 'none'}), ${failures.length} violation(s), ${skips.length} skip(s)`);
  process.exitCode = failures.length ? 1 : 0;
}
