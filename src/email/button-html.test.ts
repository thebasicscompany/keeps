import { describe, expect, it } from "vitest";
import { escapeHtml, renderButtonEmailHtml } from "@/email/button-html";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes double-quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes single-quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes all special chars together", () => {
    expect(escapeHtml(`<a href="foo?a=1&b=2">it's</a>`)).toBe(
      "&lt;a href=&quot;foo?a=1&amp;b=2&quot;&gt;it&#39;s&lt;/a&gt;",
    );
  });
});

describe("renderButtonEmailHtml — structure", () => {
  const base = {
    paragraphs: ["Hello world."],
    button: { label: "Click me", url: "https://example.com/go" },
  };

  it("contains the button href and label", () => {
    const html = renderButtonEmailHtml(base);
    expect(html).toContain('href="https://example.com/go"');
    expect(html).toContain(">Click me</a>");
  });

  it("applies seafoam button background color", () => {
    expect(renderButtonEmailHtml(base)).toContain("#C1F5DF");
  });

  it("uses inline styles only — no <style> block, no <img>", () => {
    const html = renderButtonEmailHtml(base);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<img");
  });

  it("renders paragraphs as table rows", () => {
    const html = renderButtonEmailHtml({ ...base, paragraphs: ["First.", "Second."] });
    expect(html).toContain("First.");
    expect(html).toContain("Second.");
  });

  it("renders text links as small plain links below the button", () => {
    const html = renderButtonEmailHtml({
      ...base,
      textLinks: [{ label: "Cancel", url: "https://example.com/cancel" }],
    });
    expect(html).toContain('href="https://example.com/cancel"');
    expect(html).toContain(">Cancel</a>");
    // Small font-size for secondary links
    expect(html).toContain("font-size:14px");
    // Secondary link color
    expect(html).toContain("#1E6B4F");
  });

  it("omits text link rows when textLinks is absent", () => {
    const html = renderButtonEmailHtml(base);
    expect(html).not.toContain("#1E6B4F");
  });

  it("renders footnote with muted color when provided", () => {
    const html = renderButtonEmailHtml({ ...base, footnote: "This is a footnote." });
    expect(html).toContain("This is a footnote.");
    expect(html).toContain("#6B6B65");
  });

  it("omits footnote row when absent", () => {
    const html = renderButtonEmailHtml(base);
    expect(html).not.toContain("#6B6B65");
  });
});

describe("renderButtonEmailHtml — escaping", () => {
  it("escapes HTML special chars in the button label", () => {
    const html = renderButtonEmailHtml({
      paragraphs: [],
      button: { label: "<Approve> & 'Run'", url: "https://example.com/" },
    });
    expect(html).toContain("&lt;Approve&gt; &amp; &#39;Run&#39;");
    expect(html).not.toContain("<Approve>");
  });

  it("escapes HTML special chars in the button URL", () => {
    const html = renderButtonEmailHtml({
      paragraphs: [],
      button: { label: "Go", url: 'https://example.com/?a=1&b=2">' },
    });
    // The URL is HTML-escaped; the escaped form appears in the href.
    expect(html).toContain("https://example.com/?a=1&amp;b=2&quot;&gt;");
    // The raw unescaped ampersand must not appear as a bare & in a URL context.
    expect(html).not.toContain("?a=1&b=2");
  });

  it("escapes HTML special chars in paragraph text", () => {
    const html = renderButtonEmailHtml({
      paragraphs: ["<b>Bold</b> & 'quoted'"],
      button: { label: "OK", url: "https://example.com/" },
    });
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; &#39;quoted&#39;");
  });

  it("escapes HTML special chars in text link label and URL", () => {
    const html = renderButtonEmailHtml({
      paragraphs: [],
      button: { label: "Go", url: "https://example.com/" },
      textLinks: [{ label: '<Cancel> & "abort"', url: "https://example.com/?x=1&y=2" }],
    });
    expect(html).toContain("&lt;Cancel&gt; &amp; &quot;abort&quot;");
    expect(html).toContain("https://example.com/?x=1&amp;y=2");
  });

  it("escapes HTML special chars in the footnote", () => {
    const html = renderButtonEmailHtml({
      paragraphs: [],
      button: { label: "Go", url: "https://example.com/" },
      footnote: "Note: <do not> parse & 'this'",
    });
    expect(html).toContain("Note: &lt;do not&gt; parse &amp; &#39;this&#39;");
  });
});
