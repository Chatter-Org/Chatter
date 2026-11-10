import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), names: [] as string[], fail: false }));

vi.mock("../api", () => ({
  isServerUrl: (url: string) => url.startsWith("https://chat.example/"),
  apiDiscardInterruptedUpload: async () => {},
  apiGetAuthenticatedBytes: async (url: string) => stored.files.get(url)!,
  apiUploadFile: async (source: { name: string; chunk: (a: number, b: number) => Promise<Blob>; size: number }) => {
    if (stored.fail) throw new Error("offline");
    const url = `https://chat.example/external/0123456789abcdef0123456789abcdef/${source.name}`;
    stored.names.push(source.name);
    stored.files.set(url, new Uint8Array(await (await source.chunk(0, source.size)).arrayBuffer()));
    return { url };
  },
}));

import {
  apiUploadEncryptedFile,
  fetchEncryptedFile,
  encryptedFileKind,
  encryptedFileLink,
  FILE_SEGMENT,
  openFile,
  parseEncryptedFileLink,
  sealFile,
} from "../e2e/files";

const key = new Uint8Array(32).fill(7);
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 5) & 0xff);

describe("encrypted files", () => {
  it("round-trips empty, small, exact-segment and multi-segment files", { timeout: 60_000 }, () => {
    for (const n of [0, 1, 1000, FILE_SEGMENT, FILE_SEGMENT + 1, FILE_SEGMENT * 2 + 17]) {
      const plain = bytes(n);
      expect(openFile(sealFile(plain, key), key)).toEqual(plain);
    }
  });

  it("does not open under another key, or after any tampering", () => {
    const sealed = sealFile(bytes(100), key);
    expect(() => openFile(sealed, new Uint8Array(32).fill(8))).toThrow();
    const flipped = sealed.slice();
    flipped[40] ^= 1;
    expect(() => openFile(flipped, key)).toThrow();
  });

  it("notices a file cut short or with segments reordered", () => {
    const sealed = sealFile(bytes(FILE_SEGMENT * 3), key);
    const segment = FILE_SEGMENT + 16;
    // Dropping the last segment leaves one that was not sealed as the last.
    expect(() => openFile(sealed.slice(0, 16 + segment * 2), key)).toThrow();
    // Swapping the first two.
    const swapped = sealed.slice();
    swapped.set(sealed.subarray(16 + segment, 16 + segment * 2), 16);
    swapped.set(sealed.subarray(16, 16 + segment), 16 + segment);
    expect(() => openFile(swapped, key)).toThrow();
  });

  it("keeps the key and details in a link that survives being read in a sentence", () => {
    const url = "https://chat.example/external/0123456789abcdef0123456789abcdef/9f8e7d6c5b4a.enc";
    const link = encryptedFileLink({ url, key, name: "My (holiday) photo.v2!.png", type: "image/png", size: 1234 });
    expect(link.startsWith(`${url}#k=`)).toBe(true);
    expect(link).not.toMatch(/\s/);
    expect(link).not.toMatch(/[.,)!'*(]$/);
    const info = parseEncryptedFileLink(link)!;
    expect(info.url).toBe(url);
    expect(info.key).toEqual(key);
    expect(info.name).toBe("My (holiday) photo.v2!.png");
    expect(info.type).toBe("image/png");
    expect(info.size).toBe(1234);
  });

  it("only takes encrypted uploads with a whole key", () => {
    const url = "https://chat.example/external/0123456789abcdef0123456789abcdef/9f8e7d6c5b4a.enc";
    expect(parseEncryptedFileLink(url)).toBeNull();
    expect(parseEncryptedFileLink(`${url}#k=AAAA`)).toBeNull();
    const plain = "https://chat.example/external/0123456789abcdef0123456789abcdef/cat.png";
    expect(parseEncryptedFileLink(encryptedFileLink({ url: plain, key, name: "a", type: "", size: 1 }))).toBeNull();
  });

  it("only takes uploads on this server, at an upload's own address", () => {
    const fragment = `#k=${"A".repeat(43)}&t=image%2Fpng&s=10&n=cat`;
    const folder = "/external/0123456789abcdef0123456789abcdef/9f8e7d6c5b4a.enc";
    expect(parseEncryptedFileLink(`https://chat.example${folder}${fragment}`)).not.toBeNull();
    // Fetched with the session's token, so another site must never pass.
    expect(parseEncryptedFileLink(`https://attacker.example${folder}${fragment}`)).toBeNull();
    // Nor some other address on this server that merely ends like an upload.
    expect(parseEncryptedFileLink(`https://chat.example/api/x?q=${folder}${fragment}`)).toBeNull();
    expect(parseEncryptedFileLink(`https://chat.example/api${folder}${fragment}`)).toBeNull();
  });

  it("draws only the types it is willing to, never an SVG", () => {
    expect(encryptedFileKind("image/png")).toBe("image");
    expect(encryptedFileKind("video/mp4")).toBe("video");
    expect(encryptedFileKind("audio/webm")).toBe("audio");
    expect(encryptedFileKind("image/svg+xml")).toBe("file");
    expect(encryptedFileKind("text/html")).toBe("file");
  });

  it("uploads only ciphertext under a random name, and opens it from the link", async () => {
    const secret = "the launch codes are 0000";
    const file = new File([secret], "launch-codes.txt", { type: "text/plain" });
    const { url } = await apiUploadEncryptedFile(file);
    expect(url).toMatch(/\/external\/[0-9a-f]{32}\/[0-9a-f]{24}\.enc#k=/);
    const onServer = stored.files.get(url.split("#")[0])!;
    expect(new TextDecoder("latin1").decode(onServer)).not.toContain("launch");
    expect(stored.names.at(-1)).not.toContain("launch");
    // The name rides in the fragment (sealed in the message), never in the address.
    expect(url.split("#")[0]).not.toContain("launch");
    const { blob, info } = await fetchEncryptedFile(url);
    expect(info.name).toBe("launch-codes.txt");
    expect(await blob.text()).toBe(secret);
    expect(blob.type).toBe("application/octet-stream");
  });

  it("does not open a file under the wrong key", async () => {
    const { url } = await apiUploadEncryptedFile(new File(["hi"], "a.png", { type: "image/png" }));
    const wrong = url.replace(/#k=[^&]+/, "#k=" + "A".repeat(43));
    await expect(fetchEncryptedFile(wrong)).rejects.toThrow();
  });

  it("leaves nothing behind when the upload fails", async () => {
    stored.fail = true;
    await expect(apiUploadEncryptedFile(new File(["x"], "x.bin"))).rejects.toThrow("offline");
    stored.fail = false;
  });
});
