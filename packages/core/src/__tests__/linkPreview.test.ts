import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../api", () => ({
  isServerUrl: (url: string) => url.startsWith("/") || url.startsWith("https://chat.example/"),
  apiDiscardInterruptedUpload: async () => {},
  apiGetAuthenticatedBytes: async () => new Uint8Array(),
  apiUploadFile: async (source: { name: string }) => {
    uploads.count++;
    return { url: `https://chat.example/external/0123456789abcdef0123456789abcdef/${source.name}` };
  },
}));

import { configureHost, resetHost, type PreviewFetchResult } from "../platform";
import { acceptedPreview, linkPreviewForSend, previewLink, readPageMeta, resetLinkPreviews } from "../e2e/linkPreview";

const utf8 = (text: string) => new TextEncoder().encode(text);
const PAGE = `<!doctype html><html><head>
  <!-- <meta property="og:title" content="commented out"> -->
  <script>var s = '<meta property="og:title" content="in a script">';</script>
  <title>Fallback</title>
  <meta property="og:title" content="Cats &amp; Dogs &#8212; a study">
  <meta name="description" content='Plain description'>
  <meta property="og:description" content="The &quot;real&quot; description">
  <meta property="og:image" content="/img/cover.png">
</head><body></body></html>`;

describe("previewLink", () => {
  it("takes the first link that would get a plain card", () => {
    expect(previewLink("see https://example.com/a and https://example.org/b")).toBe("https://example.com/a");
    // Drawn their own way, so passed over.
    expect(previewLink("https://youtu.be/dQw4w9WgXcQ https://cdn.example.com/x.png https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(previewLink("https://chat.example/room/!r/$e https://example.com/a")).toBe("https://example.com/a");
    expect(previewLink("no links")).toBeNull();
  });

  it("makes none for plain http, an address, or a local name", () => {
    expect(previewLink("http://example.com/a")).toBeNull();
    expect(previewLink("https://192.168.1.1/admin")).toBeNull();
    expect(previewLink("https://[::1]/x")).toBeNull();
    expect(previewLink("https://router/x")).toBeNull();
    expect(previewLink("https://nas.local/x")).toBeNull();
    expect(previewLink("https://user:pass@example.com/")).toBeNull();
    // The first plain link gets the card, so a bad one is not skipped for the next.
    expect(previewLink("http://example.com/a https://example.org/b")).toBeNull();
  });
});

describe("readPageMeta", () => {
  it("reads Open Graph first, ignoring comments and scripts, and resolves the picture", () => {
    expect(readPageMeta(PAGE, "https://example.com/post/1")).toEqual({
      title: "Cats & Dogs — a study",
      description: 'The "real" description',
      image: "https://example.com/img/cover.png",
    });
  });

  it("falls back to the title tag, and drops a bot check", () => {
    expect(readPageMeta("<title>  Just\n a   page </title>", "https://example.com/").title).toBe("Just a page");
    expect(readPageMeta("<title>Just a moment...</title>", "https://example.com/")).toEqual({});
  });

  it("reads a hostile page in one pass", () => {
    const mib = 1024 * 1024;
    for (const piece of ['<meta content="', "<!--", "<title>", "<meta ", "<script>"]) {
      const page = piece.repeat(Math.floor(mib / piece.length));
      const started = performance.now();
      readPageMeta(page, "https://example.com/");
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("keeps out tags, direction overrides and over-long text, and a picture not on https", () => {
    const meta = readPageMeta(
      `<meta property="og:title" content="<b>Bold</b> \u202Egnp.exe">` +
        `<meta property="og:description" content="${"x".repeat(1000)}">` +
        `<meta property="og:image" content="http://example.com/a.png">`,
      "https://example.com/",
    );
    expect(meta.title).toBe("Bold gnp.exe");
    expect(meta.description!.length).toBeLessThanOrEqual(300);
    expect(meta.image).toBeUndefined();
  });
});

describe("linkPreviewForSend", () => {
  const requests: { url: string; kind: string }[] = [];
  const answer = (url: string, kind: "page" | "image"): PreviewFetchResult | null => {
    requests.push({ url, kind });
    if (kind === "page") return { url, type: "text/html; charset=utf-8", bytes: utf8(PAGE) };
    return { url, type: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
  };

  beforeEach(() => {
    requests.length = 0;
    uploads.count = 0;
    resetLinkPreviews();
    configureHost({ fetchForPreview: async (url, kind) => answer(url, kind) });
  });
  afterEach(() => {
    resetHost();
    vi.useRealTimers();
  });

  it("makes none where the device cannot fetch pages itself", async () => {
    resetHost();
    expect(await linkPreviewForSend("!dm", "look https://example.com/post/1")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("reads the page and its picture on this device, and seals the picture as an encrypted upload", async () => {
    const preview = await linkPreviewForSend("!dm", "look https://example.com/post/1");
    expect(requests).toEqual([
      { url: "https://example.com/post/1", kind: "page" },
      { url: "https://example.com/img/cover.png", kind: "image" },
    ]);
    expect(preview).toMatchObject({ url: "https://example.com/post/1", title: "Cats & Dogs — a study" });
    expect(preview!.image).toMatch(/^https:\/\/chat\.example\/external\/[0-9a-f]{32}\/[0-9a-f]{24}\.enc#k=/);
    expect(uploads.count).toBe(1);

    // A retried send reuses it; another conversation gets its own upload.
    expect(await linkPreviewForSend("!dm", "look https://example.com/post/1")).toEqual(preview);
    expect(uploads.count).toBe(1);
    await linkPreviewForSend("!other", "https://example.com/post/1");
    expect(uploads.count).toBe(2);
    expect(requests.filter((r) => r.kind === "page")).toHaveLength(1);
  });

  it("takes no picture of a type it will not draw, nor a page that is not HTML", async () => {
    configureHost({
      fetchForPreview: async (url, kind) =>
        kind === "image" ? { url, type: "image/svg+xml", bytes: utf8("<svg/>") } : answer(url, kind),
    });
    const preview = await linkPreviewForSend("!dm", "https://example.com/post/1");
    expect(preview!.image).toBeUndefined();
    expect(uploads.count).toBe(0);

    resetLinkPreviews();
    configureHost({ fetchForPreview: async (url) => ({ url, type: "application/json", bytes: utf8("{}") }) });
    expect(await linkPreviewForSend("!dm", "https://example.com/post/1")).toBeNull();
  });

  it("does not hold a send back for a slow page", async () => {
    vi.useFakeTimers();
    configureHost({ fetchForPreview: () => new Promise(() => {}) });
    const pending = linkPreviewForSend("!dm", "https://example.com/slow");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
  });
});

describe("acceptedPreview", () => {
  const image = "https://chat.example/external/0123456789abcdef0123456789abcdef/0123456789abcdef01234567.enc" +
    `#k=${"A".repeat(43)}&t=image%2Fpng&s=7&n=p`;

  it("shows a preview only for a link the message carries", () => {
    const preview = { url: "https://example.com/a", title: "A", image };
    expect(acceptedPreview(preview, "see https://example.com/a")).toEqual(preview);
    expect(acceptedPreview(preview, "see https://example.com/other")).toBeUndefined();
    expect(acceptedPreview({ url: "javascript:alert(1)", title: "x" }, "javascript:alert(1)")).toBeUndefined();
  });

  it("drops a picture that is not an encrypted upload on this server", () => {
    const body = "https://example.com/a";
    expect(acceptedPreview({ url: body, title: "A", image: "https://tracker.example/p.png" }, body)).toEqual({
      url: body,
      title: "A",
    });
    expect(acceptedPreview({ url: body, title: "A", image: image.replace("image%2Fpng", "image%2Fsvg%2Bxml") }, body)).toEqual({
      url: body,
      title: "A",
    });
  });
});
