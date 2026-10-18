import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Camera, File, Images } from "lucide-react-native";
import type { PickedFile } from "@/platform/uploads";
import { showToast } from "@/platform/toast";
import { Sheet, SheetRow } from "@/ui/Sheet";

/** What a message can carry at most, as on the web (usePendingFiles). */
export const MAX_ATTACHMENTS = 10;

function fromImagePicker(assets: ImagePicker.ImagePickerAsset[]): PickedFile[] {
  return assets.map((a, i) => {
    const ext = a.mimeType?.split("/")[1]?.replace("jpeg", "jpg") ?? (a.type === "video" ? "mp4" : "jpg");
    return {
      uri: a.uri,
      name: a.fileName || `${a.type === "video" ? "video" : "photo"}-${Date.now()}-${i}.${ext}`,
      type: a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg"),
      size: a.fileSize ?? null,
    };
  });
}

/** Where an attachment comes from: the gallery, the camera, or any file. */
export function AttachSheet({
  open,
  onClose,
  onPicked,
  room,
}: {
  open: boolean;
  onClose(): void;
  onPicked(files: PickedFile[]): void;
  /** How many more files the message can take. */
  room: number;
}) {
  const pick = async (from: "library" | "camera" | "files") => {
    onClose();
    try {
      if (from === "files") {
        const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (!result.canceled) {
          onPicked(
            result.assets.slice(0, room).map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? null, size: a.size ?? null, lastModified: a.lastModified })),
          );
        }
        return;
      }
      if (from === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          showToast({ message: "Camera access is off for Chatter", description: "Turn it on in the phone's settings.", tone: "error" });
          return;
        }
        const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images", "videos"], quality: 0.9 });
        if (!result.canceled) onPicked(fromImagePicker(result.assets));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsMultipleSelection: true,
        selectionLimit: room,
        quality: 1,
      });
      if (!result.canceled) onPicked(fromImagePicker(result.assets));
    } catch (e) {
      showToast({ message: "Couldn't open the picker", description: String((e as Error)?.message ?? e), tone: "error" });
    }
  };

  return (
    // The web's attach menu, as sheet rows.
    <Sheet open={open} onClose={onClose} title="Attach">
      <SheetRow icon={Images} label="Photos and videos" onPress={() => void pick("library")} />
      <SheetRow icon={Camera} label="Take a photo or video" onPress={() => void pick("camera")} />
      <SheetRow icon={File} label="Files" onPress={() => void pick("files")} />
    </Sheet>
  );
}
