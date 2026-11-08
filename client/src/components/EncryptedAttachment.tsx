import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, File as FileIcon, Lock, Play } from "lucide-react";
import { encryptedFileKind, fetchEncryptedFile, parseEncryptedFileLink } from "@chatter/core/e2e/files";
import { loadMediaBlob, peekMediaBlob, releaseMediaBlob } from "@/lib/mediaBlobs";

/** Pictures up to this size open on their own; anything bigger waits to be
 *  asked for, since it is fetched and decrypted in memory. */
const AUTO_LOAD_BYTES = 25 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decrypt a file into an object URL, kept in the shared blob cache under the
 *  link (which includes the key, so it is private to this message). */
const decryptToObjectUrl = async (link: string) =>
  URL.createObjectURL((await fetchEncryptedFile(link)).blob);

/**
 * A file sent into an end-to-end encrypted conversation. The server holds only
 * ciphertext; this fetches it and opens it here, using the key that came inside
 * the message.
 *
 * Only types the page is willing to draw (see `encryptedFileKind`) are given to
 * an `<img>`, `<video>` or `<audio>`; everything else is a download. A blob
 * URL is never opened as a page, so a hostile file cannot run as the app.
 */
export function EncryptedAttachment({ link }: { link: string }) {
  const info = useMemo(() => parseEncryptedFileLink(link), [link]);
  const kind = info ? encryptedFileKind(info.type) : "file";
  const autoLoad = kind === "image" && !!info && info.size <= AUTO_LOAD_BYTES;
  // Already opened once (scrolled away and back): open it again without asking.
  const [wanted, setWanted] = useState(autoLoad || peekMediaBlob(link) !== null);
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({
    url: peekMediaBlob(link),
    failed: false,
  });

  useEffect(() => {
    if (!wanted || kind === "file") return;
    let live = true;
    let held = false;
    loadMediaBlob(link, decryptToObjectUrl).then(
      (url) => {
        if (!live) {
          releaseMediaBlob(link);
          return;
        }
        held = true;
        setState({ url, failed: false });
      },
      () => live && setState({ url: null, failed: true }),
    );
    return () => {
      live = false;
      if (held) releaseMediaBlob(link);
    };
  }, [link, wanted, kind]);

  const download = useCallback(async () => {
    if (!info) return;
    try {
      const { blob } = await fetchEncryptedFile(link);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = info.name;
      a.rel = "noopener";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setState({ url: null, failed: true });
    }
  }, [info, link]);

  if (!info) return null;

  if (state.failed) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm text-muted-foreground max-w-sm">
        <Lock className="h-4 w-4 shrink-0" />
        <span className="truncate">{info.name} couldn't be decrypted</span>
      </div>
    );
  }

  if (state.url && kind === "image") {
    return <img src={state.url} alt={info.name} className="max-w-full max-h-80 h-auto rounded-md" referrerPolicy="no-referrer" />;
  }
  if (state.url && kind === "video") {
    return <video src={state.url} controls preload="metadata" className="max-w-full max-h-80 rounded-md" />;
  }
  if (state.url && kind === "audio") {
    return <audio src={state.url} controls className="max-w-full" />;
  }

  const loading = wanted && kind !== "file";
  const Icon = kind === "video" || kind === "audio" ? Play : FileIcon;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => (kind === "file" ? void download() : setWanted(true))}
      className="mt-1 flex items-center gap-3 rounded-md border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors px-3 py-2.5 max-w-sm text-left disabled:opacity-70"
    >
      <Icon className="h-8 w-8 text-muted-foreground shrink-0" />
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium truncate">{info.name}</span>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="h-3 w-3" />
          {loading ? "Decrypting…" : `Encrypted · ${formatSize(info.size)} · ${kind === "file" ? "click to download" : "click to open"}`}
          {kind === "file" && <Download className="h-3 w-3" />}
        </span>
      </div>
    </button>
  );
}
