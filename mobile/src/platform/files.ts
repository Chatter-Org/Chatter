import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { getAccessToken } from "@chatter/core/api";
import { serverAsset } from "./server";
import { showToast } from "./toast";

/**
 * Fetch a file from the server and hand it to the phone: the share sheet,
 * from which it can be opened, saved, or sent on. The web downloads; a phone
 * shares.
 */
export async function saveServerFile(path: string, name: string): Promise<void> {
  const url = serverAsset(path);
  if (!url) return;
  try {
    const dir = new Directory(Paths.cache, "downloads");
    if (!dir.exists) dir.create({ intermediates: true });
    const target = new File(dir, name);
    if (target.exists) target.delete();
    const token = getAccessToken();
    const file = await File.downloadFileAsync(url, target, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, { dialogTitle: name });
    } else {
      showToast({ message: "Saved", description: name });
    }
  } catch (e) {
    showToast({ message: "Couldn't get that file", description: String((e as Error)?.message ?? e), tone: "error" });
  }
}
