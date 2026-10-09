import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { fileUriPath, terminalFileLinks } from "./terminalFileLinks.ts";

/** a plain press of the primary button, as xterm hands one to a link */
const click = { button: 0 } as MouseEvent;
const written = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

describe("terminal file links", () => {
  it("excludes sentence punctuation but preserves encoded filename punctuation", async () => {
    const term = new Terminal({ cols: 150, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("file:///tmp/a.md: file:///tmp/a.md! file:///tmp/a.md? file:///tmp/a%21.md", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["file:///tmp/a.md", "file:///tmp/a.md", "file:///tmp/a.md", "file:///tmp/a%21.md"]);
    for (const link of links) link.activate(click);
    expect(opened).toEqual(["/tmp/a.md", "/tmp/a.md", "/tmp/a.md", "/tmp/a!.md"]);
    term.dispose();
  });
  it("keeps an apostrophe inside a file URI and drops one after it", async () => {
    const term = new Terminal({ cols: 120, allowProposedApi: true });
    await written(term, "see file:///tmp/Bob's-notes.md and 'file:///tmp/a.md'");
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["file:///tmp/Bob's-notes.md", "file:///tmp/a.md"]);
    term.dispose();
  });
  it("does not append an unrelated hard row after a full-width URI", async () => {
    const uri = "file:///tmp/README.md";
    const term = new Terminal({ cols: uri.length, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(uri + "\r\nPASS unrelated output", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    links[0]?.activate(click);
    expect(opened).toEqual(["/tmp/README.md"]);
    term.dispose();
  });
  it("does not link method calls or dotted identifiers", async () => {
    const term = new Terminal({ cols: 160, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("tool.monitor({}) display(await tool.read({})) Math.random process.env example.com README.md src/custom.monitor", resolve));
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["src/custom.monitor"]);
    term.dispose();
  });
  it("opens a wrapped file URI with encoded Korean and spaces", async () => {
    const term = new Terminal({ cols: 40, allowProposedApi: true });
    const uri = "file:///tmp/%ED%95%9C%EA%B8%80%20sheet.png";
    await new Promise<void>((resolve) => term.write(uri, resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual([uri]);
    links[0]?.activate(click);
    expect(opened).toEqual(["/tmp/한글 sheet.png"]);
    term.dispose();
  });

  it("rejects malformed or nonlocal file URIs", () => {
    for (const uri of ["file://host/tmp/a.png", "file:///tmp/%zz", "file:///tmp/%00", "https://example.com/a.png"])
      expect(fileUriPath(uri)).toBeNull();
    // a network share on a Windows PC, however its second separator is written, and a control character
    for (const uri of ["file:////attacker.example/share/doc.txt", "file:///%2Fattacker.example/share/doc.txt", "file:///%5C%5Cattacker.example/share", "file:///tmp/a.md\u0000", "file:///tmp/a\u001b.md"])
      expect(fileUriPath(uri)).toBeNull();
    // a control character written encoded is refused too: the server trimmed `%0A` and opened /etc/hosts
    for (const uri of ["file:///etc/hosts%0A", "file:///tmp/a%1B.md", "file:///tmp/a%7F.md"]) expect(fileUriPath(uri)).toBeNull();
    // an apostrophe belongs to the name
    expect(fileUriPath("file:///tmp/Bob's-notes.md")).toBe("/tmp/Bob's-notes.md");
    // a Windows drive path loses the slash a URI puts before it
    expect(fileUriPath("file:///C:/Users/Alice/readme.md")).toBe("C:/Users/Alice/readme.md"); // leakscan:allow: test fixture
  });

  it("reads a long line of paths in one pass", async () => {
    // `(src/a.ts)` over and over as one wrapped line froze the page for seconds while hovering
    const term = new Terminal({ cols: 200, rows: 40, allowProposedApi: true });
    await written(term, "(src/a.ts)".repeat(700));
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toHaveLength(20);
    term.dispose();
    // past a bundle's length it is no prose with paths in it, and is left alone
    const blob = new Terminal({ cols: 200, rows: 60, allowProposedApi: true });
    await written(blob, "(src/a.ts)".repeat(900));
    expect(terminalFileLinks(blob.buffer.active, 1, () => {})).toEqual([]);
    blob.dispose();
  });

  it("does not link the tail of a line whose beginning scrolled off", async () => {
    const term = new Terminal({ cols: 20, rows: 2, scrollback: 0, allowProposedApi: true });
    await written(term, "file:///work/abcdefghijk/subdir/App.tsx\r\n");
    // the top row now starts in the middle of the address: `hijk/subdir/App.tsx` is no path of its own
    expect(term.buffer.active.getLine(0)?.isWrapped).toBe(true);
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toEqual([]);
    term.dispose();
  });

  it("keeps a name with a combining mark whole", async () => {
    const term = new Terminal({ cols: 80, allowProposedApi: true });
    await written(term, "see src/cafe\u0301/index.ts");
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links).toHaveLength(1);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/cafe\u0301/index.ts"]);
    term.dispose();
  });

  it("links a compiler's file(line,column) and leaves a call alone", async () => {
    const term = new Terminal({ cols: 120, allowProposedApi: true });
    await written(term, "src/App.tsx(120,8): error TS1000 lib/run.js(42) and lib/run.js(arg)");
    expect(terminalFileLinks(term.buffer.active, 1, () => {}).map((link) => link.text)).toEqual(["src/App.tsx", "lib/run.js"]);
    term.dispose();
  });

  it("ends a link on the last cell of a wide character", async () => {
    const term = new Terminal({ cols: 80, allowProposedApi: true });
    await written(term, "file:///tmp/한글");
    // 12 narrow cells, then two characters of two cells each
    expect(terminalFileLinks(term.buffer.active, 1, () => {})[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 16, y: 1 } });
    term.dispose();
  });

  it("opens nothing when the row no longer shows the link it was read from", async () => {
    const term = new Terminal({ cols: 80, allowProposedApi: true });
    await written(term, "open src/old.ts");
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["src/old.ts"]);
    // herdr repaints the row; xterm still holds the link it read before
    await written(term, "\r\u001b[2Kopen src/new.ts");
    links[0]?.activate(click);
    expect(opened).toEqual([]);
    // the same link grown by a letter is another file
    await written(term, "\r\u001b[2Kopen src/foo.ts");
    const grown = terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path));
    await written(term, "x");
    grown[0]?.activate(click);
    expect(opened).toEqual([]);
    // a link still shown opens
    terminalFileLinks(term.buffer.active, 1, (path) => opened.push(path))[0]?.activate(click);
    expect(opened).toEqual(["src/foo.tsx"]);
    term.dispose();
  });
  it("opens the full path when a wide character wraps from the last column", async () => {
    const term = new Terminal({ cols: 40, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("check: ".padEnd(30) + "src/abc한글.ts", resolve));
    const opened: string[] = [];
    const links = terminalFileLinks(term.buffer.active, 2, (path) => opened.push(path));
    expect(links.map((link) => link.text)).toEqual(["src/abc한글.ts"]);
    links[0]?.activate(click);
    expect(opened).toEqual(["src/abc한글.ts"]);
    term.dispose();
  });
  it("leaves a bare file name alone: only a path with a folder in it, or a file URI, is a link", async () => {
    const term = new Terminal({ cols: 120, allowProposedApi: true });
    // what `ls` and `git status` print: a tap to focus the pane must not open the file viewer
    await new Promise<void>((resolve) => term.write("README.md package.json main.c\r\n M src/App.tsx\r\n?? ./notes.txt ~/x/a.md /etc/hosts.conf", resolve));
    const texts = (line: number) => terminalFileLinks(term.buffer.active, line, () => {}).map((link) => link.text);
    expect(texts(1)).toEqual([]);
    expect(texts(2)).toEqual(["src/App.tsx"]);
    expect(texts(3)).toEqual(["./notes.txt", "~/x/a.md", "/etc/hosts.conf"]);
    term.dispose();
  });
  it("recognizes files with line and column suffixes", async () => {
    const term = new Terminal({ cols: 100, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("see src/app.ts:42:3 and README.md", resolve));
    const links = terminalFileLinks(term.buffer.active, 1, () => {});
    expect(links.map((link) => link.text)).toEqual(["src/app.ts:42:3"]);
    term.dispose();
  });

  it("keeps cell coordinates after Korean text and across wrapped lines", async () => {
    const term = new Terminal({ cols: 20, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("확인 src/폴더/example.ts", resolve));
    const links = terminalFileLinks(term.buffer.active, 2, () => {});
    expect(links.map((link) => link.text)).toEqual(["src/폴더/example.ts"]);
    expect(links[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 4, y: 2 } });
    term.dispose();
  });

  it("does not turn URLs, versions or ordinary words into file links", async () => {
    const term = new Terminal({ cols: 150, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write("https://example.com/src/app.ts v1.2.3 1.2.3 and/or", resolve));
    expect(terminalFileLinks(term.buffer.active, 1, () => {})).toEqual([]);
    term.dispose();
  });
});

it('never opens a truncated URI parent from hard screen rows',async()=>{
 const uri='file:///synthetic/parent';const term=new Terminal({cols:uri.length,allowProposedApi:true});await written(term,uri+'\r\n/file.txt');expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);const opened:string[]=[];for(const link of terminalFileLinks(term.buffer.active,1,path=>opened.push(path)))link.activate(click);expect(opened).toEqual([]);term.dispose();
});
it('identical bytes preserve soft-wrap whole URI and cell ranges',async()=>{
 const uri='file:///synthetic/parent/file.txt';const term=new Terminal({cols:23,allowProposedApi:true});await written(term,uri);expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);const opened:string[]=[];const links=terminalFileLinks(term.buffer.active,1,path=>opened.push(path));expect(links[0]?.text).toBe(uri);links[0]?.activate(click);expect(opened).toEqual(['/synthetic/parent/file.txt']);term.dispose();
});
