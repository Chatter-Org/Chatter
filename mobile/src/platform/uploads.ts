import { File, FileMode, Paths } from "expo-file-system";
import type { UploadPart, UploadSource } from "@chatter/core/uploadResume";

/**
 * A picked file as something the shared upload code can send.
 *
 * The whole file goes by reference — React Native's FormData reads it from
 * disk itself. A large file is sent in chunks (the same resumable protocol the
 * web uses), and a chunk has to be a file of its own to go by reference, so
 * each is read from the original and written to the cache first, then
 * removed once it is on its way.
 */
export interface PickedFile {
  uri: string;
  name: string;
  /** MIME type, when the picker knows it. */
  type?: string | null;
  size?: number | null;
  lastModified?: number | null;
}

export function nativeUploadSource(picked: PickedFile): UploadSource {
  const file = new File(picked.uri);
  const size = picked.size ?? file.size ?? 0;
  const type = picked.type || "application/octet-stream";
  const whole: UploadPart = { uri: picked.uri, name: picked.name, type };
  let chunkFile: File | null = null;

  return {
    name: picked.name,
    size,
    lastModified: picked.lastModified ?? undefined,
    part: () => whole,
    async chunk(start, end) {
      // The previous chunk has been sent by the time the next is asked for.
      try {
        chunkFile?.delete();
      } catch {
        // Already gone.
      }
      const handle = file.open(FileMode.ReadOnly);
      try {
        handle.offset = start;
        const bytes = await handle.readBytes(end - start);
        chunkFile = new File(Paths.cache, `upload-${Date.now()}-${start}.part`);
        chunkFile.create({ overwrite: true });
        await chunkFile.write(bytes);
        return { uri: chunkFile.uri, name: picked.name, type: "application/octet-stream" };
      } finally {
        handle.close();
      }
    },
  };
}
