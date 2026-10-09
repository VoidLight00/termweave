import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../components/Markdown.tsx";
import { SettingsProvider } from "./settings.ts";
import { FOLD_CODE_AFTER_LINES, FOLDED_CODE_LINES, foldCode, parseInline, parseMarkdown, safeMarkdownHref, type InlineNode, type ListBlock } from "./markdown.ts";

describe("parseMarkdown", () => {
  it("renders inline and display math while leaving fenced code untouched", () => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: "\\(x_i\\)\n\n\\[\\mathrm{ECA@}k=\\frac{1}{N}\\sum_i\\mathbf{1}[\\text{예측}_i=\\text{정답}_i]\\]" }) }));
      expect(html).toContain("katex-display");
      expect(html).toContain("katex-html");
      expect(html).not.toContain("katex-error");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
  it("parses level one through three headings", () => {
    expect(parseMarkdown("# One\n## Two\n### Three").map((block) => block.type === "heading" ? block.level : null)).toEqual([1, 2, 3]);
  });

  it("parses unordered, ordered, and one-level nested lists", () => {
    const blocks = parseMarkdown("- first\n  - nested\n- second\n\n1. one\n2. two");
    expect(blocks[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ blocks: [{ type: "list", ordered: false, items: [{ content: [{ type: "text", value: "nested" }] }] }] }, {}],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true, items: [{}, {}] });
  });

  it("keeps fenced code and its language", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```")).toEqual([{ type: "code", language: "ts", value: "const x = 1;" }]);
  });

  it("recognizes display math without parsing its contents as markdown", () => {
    const formula = "\\[\n\\mathrm{ECA@}k = \\frac{1}{N}\\sum_i \\mathbf{1}[\\text{예측}_i=\\text{정답}_i]\\,\\prod_j\\mathbf{1}[|F_i\\cap I_{ij}|\\ge k]\n\\]";
    expect(parseMarkdown(formula)).toEqual([{ type: "math", value: formula.slice(3, -3) }]);
    expect(parseMarkdown("before\n\\[x^2\\]\nafter").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("```tex\n\\[x\\]\n```")).toEqual([{ type: "code", language: "tex", value: "\\[x\\]" }]);
    expect(parseMarkdown("\\[unfinished")).toEqual([{ type: "paragraph", lines: [[{ type: "text", value: "\\[unfinished" }]] }]);
  });

  it("keeps later markdown and code intact after an unclosed display formula", () => {
    for (const code of ["raw code", "\\]"]) {
      expect(parseMarkdown(`\\[unfinished\n\n# Still a heading\n\n\`\`\`tex\n${code}\n\`\`\`\n\n- still a list`).map((block) => block.type)).toEqual([
        "paragraph", "heading", "code", "list",
      ]);
    }
  });

  it("parses a GFM table", () => {
    const [table] = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | b |");
    expect(table).toMatchObject({ type: "table", header: [[{ value: "Name" }], [{ value: "Value" }]], rows: [[[{ value: "a" }], [{ value: "b" }]]] });
  });
});

describe("inline markdown", () => {
  it("parses links and rejects unsafe protocols", () => {
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(parseInline("[safe](https://example.com) [unsafe](javascript:bad)" )).toMatchObject([
      { type: "link", href: "https://example.com" },
      { type: "text", value: " " },
      { type: "text", value: "unsafe" },
    ]);
  });

  it("keeps a link to a local file as that file, not only its label", () => {
    expect(parseInline("근거: [실험 결과](/home/u/repo/output/REPORT.md)")).toEqual([ // leakscan:allow: test fixture
      { type: "text", value: "근거: " },
      { type: "file", path: "/home/u/repo/output/REPORT.md", children: [{ type: "text", value: "실험 결과" }] }, // leakscan:allow: test fixture
    ]);
    expect(parseInline("[x](src/x.ts#L12) [y](~/y.md:3:1)")).toMatchObject([
      { type: "file", path: "src/x.ts" },
      { type: "text", value: " " },
      { type: "file", path: "~/y.md" },
    ]);
    for (const target of ["javascript:bad", "data:text/html,x", "#section"]) {
      expect(parseInline(`[label](${target})`)).toEqual([{ type: "text", value: "label" }]);
    }
  });

  it("links an address written without its scheme, and leaves files and non-addresses alone", () => {
    expect(parseInline("[docs](www.example.com/x)")).toEqual([{ type: "link", href: "https://www.example.com/x", children: [{ type: "text", value: "docs" }] }]);
    expect(parseInline("[guide](docs.example.com/guide)")).toMatchObject([{ type: "link", href: "https://docs.example.com/guide" }]);
    expect(parseInline("[here](localhost:7317)")).toMatchObject([{ type: "link", href: "http://localhost:7317" }]);
    expect(parseInline("[api](api.example.com:8443/v1)")).toMatchObject([{ type: "link", href: "https://api.example.com:8443/v1" }]);
    expect(parseInline("[readme](README.md)")).toMatchObject([{ type: "file", path: "README.md" }]);
    expect(parseInline("[x](src/x.ts)")).toMatchObject([{ type: "file", path: "src/x.ts" }]);
    expect(parseInline("see www.example.com/a/b.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://www.example.com/a/b", children: [{ type: "text", value: "www.example.com/a/b" }] },
      { type: "text", value: "." },
    ]);
    // a file and its line, or a folder with a dot, is not an address
    expect(parseInline("[main.ts](main.ts:42)")).toMatchObject([{ type: "file", path: "main.ts" }]);
    expect(parseInline("[README.md](README.md:3:1)")).toMatchObject([{ type: "file", path: "README.md" }]);
    expect(parseInline("[notes](notes.v2/todo.md)")).toMatchObject([{ type: "file", path: "notes.v2/todo.md" }]);
    expect(parseInline("[call](tel:123)")).toEqual([{ type: "text", value: "call" }]);
    // a local server by address is plain http, as localhost is
    expect(parseInline("[server](127.0.0.1:8080)")).toMatchObject([{ type: "link", href: "http://127.0.0.1:8080" }]);
    expect(parseInline("[dev](192.168.0.10:5173/app)")).toMatchObject([{ type: "link", href: "http://192.168.0.10:5173/app" }]);
    expect(parseInline("[v](1.2.3.4)")).toMatchObject([{ type: "file", path: "1.2.3.4" }]);
    // a bare domain in prose stays prose, and a code span keeps its address as code (rendered as a link)
    expect(parseInline("example.com is fine")).toEqual([{ type: "text", value: "example.com is fine" }]);
    expect(parseInline("`https://example.com/x`")).toEqual([{ type: "code", value: "https://example.com/x" }]);
  });

  it("parses inline code, bold, italic, and strikethrough", () => {
    expect(parseInline("`code` **bold** *italic* ~~gone~~").map((node) => node.type)).toEqual([
      "code", "text", "strong", "text", "em", "text", "del",
    ]);
  });

  it("renders inline math in prose but not in code spans", () => {
    expect(parseInline("Result \\(x_i + \\frac{1}{N}\\) and `\\(raw\\)`")).toEqual([
      { type: "text", value: "Result " },
      { type: "math", value: "x_i + \\frac{1}{N}" },
      { type: "text", value: " and " },
      { type: "code", value: "\\(raw\\)" },
    ]);
    expect(parseInline("\\(unfinished")).toEqual([{ type: "text", value: "\\(unfinished" }]);
  });

  it("preserves underscores in identifiers while retaining standalone emphasis", () => {
    for (const value of ["MAC_QA_CHAT_OK", "api_key_name", "foo__bar__baz", "한글_세션_이름"]) {
      expect(parseInline(value)).toEqual([{ type: "text", value }]);
    }
    expect(parseInline("_italic_ (__bold__) `api_key_name`").map((node) => node.type)).toEqual([
      "em", "text", "strong", "text", "code",
    ]);
    expect(parseInline("__MAC_QA_CHAT_OK__")).toEqual([
      { type: "strong", children: [{ type: "text", value: "MAC_QA_CHAT_OK" }] },
    ]);
  });
});

describe("autolinks", () => {
  const link = (href: string): InlineNode => ({ type: "link", href, children: [{ type: "text", value: href }] });

  it("links a bare http(s) URL and keeps the text around it", () => {
    expect(parseInline("https://github.com/devswha/herdr-web-ui/pull/36 이런거")).toEqual([
      link("https://github.com/devswha/herdr-web-ui/pull/36"),
      { type: "text", value: " 이런거" },
    ]);
    // no space before Korean: the address ends at the first non-ASCII character
    expect(parseInline("see https://example.com/a에서 확인")).toEqual([
      { type: "text", value: "see " }, link("https://example.com/a"), { type: "text", value: "에서 확인" },
    ]);
  });

  it("leaves the sentence's punctuation out, and keeps parentheses the URL opened", () => {
    expect(parseInline("(see https://example.com/a).")).toEqual([
      { type: "text", value: "(see " }, link("https://example.com/a"), { type: "text", value: ")." },
    ]);
    expect(parseInline("https://en.wikipedia.org/wiki/Rust_(language), then")).toEqual([
      link("https://en.wikipedia.org/wiki/Rust_(language)"), { type: "text", value: ", then" },
    ]);
    expect(parseInline("done: https://example.com/x?y=1&z=2!")).toEqual([
      { type: "text", value: "done: " }, link("https://example.com/x?y=1&z=2"), { type: "text", value: "!" },
    ]);
  });

  it("links an <angle> URL, and nothing inside code, a markdown link, or another scheme", () => {
    expect(parseInline("<https://example.com/a>")).toEqual([link("https://example.com/a")]);
    expect(parseInline("`https://example.com`")).toEqual([{ type: "code", value: "https://example.com" }]);
    expect(parseInline("[https://example.com](https://example.com/b)")).toEqual([
      { type: "link", href: "https://example.com/b", children: [{ type: "text", value: "https://example.com" }] },
    ]);
    for (const value of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "http:/x"]) {
      expect(parseInline(value).some((node) => node.type === "link")).toBe(false);
    }
  });

  it("links inside emphasis", () => {
    expect(parseInline("**https://example.com**")).toEqual([{ type: "strong", children: [link("https://example.com")] }]);
  });
  it("opens a labeled local file URI through the file viewer", () => {
    expect(parseInline("file:///tmp/README.md")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "file:///tmp/README.md" }] },
    ]);
    // Korean written straight after the address is prose, as it is after an http one
    expect(parseInline("file:///tmp/a.md에서 확인")).toEqual([
      { type: "file", path: "/tmp/a.md", children: [{ type: "text", value: "file:///tmp/a.md" }] },
      { type: "text", value: "에서 확인" },
    ]);
    expect(parseInline("file:///tmp/Bob's-notes.md")).toEqual([
      { type: "file", path: "/tmp/Bob's-notes.md", children: [{ type: "text", value: "file:///tmp/Bob's-notes.md" }] },
    ]);
    expect(parseInline("[README](file:///tmp/README.md)")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "README" }] },
    ]);
  });
});

describe("foldCode", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("shows blocks up to the limit whole", () => {
    expect(foldCode(lines(12))).toBeNull();
    expect(foldCode(lines(FOLD_CODE_AFTER_LINES))).toBeNull();
  });

  it("folds a longer block to its first lines and counts all of them", () => {
    const fold = foldCode(lines(382));
    expect(fold?.lines).toBe(382);
    expect(fold?.head.split("\n")).toHaveLength(FOLDED_CODE_LINES);
    expect(fold?.head.startsWith("line 1\n")).toBe(true);
    expect(fold?.head.endsWith(`line ${FOLDED_CODE_LINES}`)).toBe(true);
  });
});

describe("numbered lists as agents write them", () => {
  const render = (source: string): string => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: source }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const lists = (source: string) => parseMarkdown(source).map((block) => block.type === "list" ? { start: block.start ?? 1, items: block.items.length } : block.type);

  it("keeps one list across blank lines between its items", () => {
    expect(lists("1. a\n\n2. b\n\n3. c")).toEqual([{ start: 1, items: 3 }]);
  });

  it("goes on from its own number after a code block or other break, and starts where it says", () => {
    expect(lists("1. first\n```\ncode\n```\n2. second\n3. third")).toEqual([{ start: 1, items: 1 }, "code", { start: 2, items: 2 }]);
    expect(lists("3. three\n4. four")).toEqual([{ start: 3, items: 2 }]);
  });

  it("reads an item's indented lines as its own text, and an indented fence as code", () => {
    const blocks = parseMarkdown("1. first\n   more about it\n2. second");
    expect(lists("1. first\n   more about it\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const first = (blocks[0] as Extract<ReturnType<typeof parseMarkdown>[number], { type: "list" }>).items[0]!;
    expect(first.content.map((node) => node.type === "text" ? node.value : "").join("")).toBe("first more about it");
    const fenced = parseMarkdown("1. run it\n   ```sh\n   bun test\n   ```\n2. then this");
    expect(fenced.map((block) => block.type)).toEqual(["list", "code", "list"]);
    expect(fenced[1]).toEqual({ type: "code", language: "sh", value: "bun test" });
  });

  it("shows a table indented under an item as a table in that item, not as the item's text", () => {
    const blocks = parseMarkdown("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n     | b | `[2,3]` |\n\n   - after it\n\n2. second");
    expect(lists("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n\n   - after it\n\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const item = (blocks[0] as ListBlock).items[0]!;
    const nested = item.blocks?.[0] as ListBlock;
    // the sibling after the table stays nested, in the same list as the item the table is under
    expect(nested.items.map((entry) => entry.content)).toEqual([[{ type: "text", value: "Example:" }], [{ type: "text", value: "after it" }]]);
    expect(nested.items[0]?.blocks?.[0]).toMatchObject({ type: "table", header: [[{ value: "Way" }], [{ value: "Box" }]], rows: [[[{ value: "a" }], [{ type: "code", value: "[0,1]" }]], [[{ value: "b" }], [{ type: "code", value: "[2,3]" }]]] });
  });

  it("goes on counting after a table in an item, the way agents number every item 1.", () => {
    const source = "1. first\n\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n\n1. second\n1. third";
    expect(lists(source)).toEqual([{ start: 1, items: 3 }]);
    const html = render(source);
    expect(html).toContain('<ol class="markdown-list"><li><span>first</span><div class="markdown-table-wrap"><table>');
    expect(html.match(/<ol/g)).toHaveLength(1);
  });

  it("keeps a table and a nested list under one item in the order they were written", () => {
    const [list] = parseMarkdown("- item\n  - sub\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n  - more\n- next");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type)).toEqual(["list", "table", "list"]);
    expect((list as ListBlock).items).toHaveLength(2);
  });

  it("keeps an item's text after its table below the table", () => {
    const source = "1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   After the table.\n   And more.\n\n   Another paragraph.\n\n1. Next";
    const [list] = parseMarkdown(source);
    expect(lists(source)).toEqual([{ start: 1, items: 2 }]);
    const item = (list as ListBlock).items[0]!;
    expect(item.content).toEqual([{ type: "text", value: "Before" }]);
    expect(item.blocks).toMatchObject([
      { type: "table" },
      { type: "paragraph", lines: [[{ value: "After the table." }], [{ value: "And more." }]] },
      { type: "paragraph", lines: [[{ value: "Another paragraph." }]] },
    ]);
    expect(render(source)).toContain("</table></div><p>");
  });

  it("ends the list at a quote after an item's table, as before tables nested", () => {
    const blocks = parseMarkdown("1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   > Note\n\n1. Next");
    expect(blocks.map((block) => block.type)).toEqual(["list", "blockquote", "list"]);
  });

  it("ends an item's table at the next item or a line outside the item", () => {
    const [list] = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\n- next | value");
    expect((list as ListBlock).items.map((item) => item.content)).toEqual([[{ type: "text", value: "item" }], [{ type: "text", value: "next | value" }]]);
    expect((list as ListBlock).items[0]?.blocks?.[0]).toMatchObject({ type: "table", rows: [[[{ value: "x" }], [{ value: "y" }]]] });
    const blocks = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\nnot | in it");
    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
  });

  it("keeps both of two nested lists under one item", () => {
    const [list] = parseMarkdown("- item\n  - bullet\n  1. step");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type === "list" && block.ordered)).toEqual([false, true]);
  });

  it("escapes markup in a table cell inside a list item", () => {
    const html = render("- item\n\n  | <b>x</b> | y |\n  |---|---|\n  | <script>alert(1)</script> | <img src=x onerror=alert(1)> |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });
});
