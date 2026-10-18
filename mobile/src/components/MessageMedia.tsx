import { memo, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Download, FileText, Pause, Play } from "lucide-react-native";
import type { BodyMedia } from "@chatter/core/messageFormat";
import { getAccessToken } from "@chatter/core/api";
import { serverAsset } from "@/platform/server";
import { serverImage } from "@/ui/media";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { ImageViewer } from "./ImageViewer";
import { useDevicePrefs } from "@/state/devicePrefs";
import { ForumLinkCard, LinkPreviewCard, MessageLinkCard } from "./LinkCards";
import { saveServerFile } from "@/platform/files";

/** The session header for media the server may only show to members. */
function authHeaders(): Record<string, string> | undefined {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/** The last path segment, decoded: what an upload is called. */
function fileName(url: string): string {
  const last = url.split("?")[0].split("/").pop() ?? url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * What a message carries besides its text, drawn as the web draws it:
 * pictures, video, audio, files, YouTube — each in a form a thumb can use.
 */
export const MessageMedia = memo(function MessageMedia({ media, spoiler }: { media: BodyMedia; spoiler?: boolean }) {
  const { linkPreviews } = useDevicePrefs();
  const [viewing, setViewing] = useState<number | null>(null);
  const hasAny =
    media.images.length +
      media.videos.length +
      media.audios.length +
      media.files.length +
      media.youtubeIds.length +
      media.links.length +
      media.messageLinks.length +
      media.forumLinks.length >
    0;
  if (!hasAny) return null;

  return (
    <View className="mt-2 gap-2">
      {media.images.length > 0 && (
        <ImageGrid urls={media.images} onOpen={setViewing} blurred={spoiler} />
      )}
      {media.videos.map((url) => (
        <InlineVideo key={url} url={url} />
      ))}
      {media.audios.map((url) => (
        <AudioRow key={url} url={url} />
      ))}
      {media.files.map((url) => (
        <FileCard key={url} url={url} />
      ))}
      {media.youtubeIds.map((id) => (
        <YouTubeCard key={id} id={id} />
      ))}
      {media.messageLinks.map((url) => (
        <MessageLinkCard key={url} url={url} />
      ))}
      {media.forumLinks.map((url) => (
        <ForumLinkCard key={url} url={url} />
      ))}
      {/* One page preview, for the first link, as on the web. */}
      {media.links.length > 0 && linkPreviews ? <LinkPreviewCard url={media.links[0]} /> : null}
      <ImageViewer urls={media.images} index={viewing} onClose={() => setViewing(null)} />
    </View>
  );
});

function ImageGrid({ urls, onOpen, blurred }: { urls: string[]; onOpen(i: number): void; blurred?: boolean }) {
  const [revealed, setRevealed] = useState(!blurred);
  // The picture's own shape, as the web draws it: as wide as the message
  // allows, no taller than max-h-80 (352px).
  const { autoplayAnimated: autoplay } = useDevicePrefs();
  const [aspect, setAspect] = useState(4 / 3);
  const [room, setRoom] = useState(0);
  if (urls.length === 1) {
    const width = room ? Math.min(room, 352 * aspect) : 0;
    return (
      <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
        <Pressable onPress={() => (revealed ? onOpen(0) : setRevealed(true))} accessibilityRole="imagebutton" accessibilityLabel="Image, tap to open">
        <Image
          source={serverImage(urls[0])}
          onLoad={(e) => e.source.width && e.source.height && setAspect(e.source.width / e.source.height)}
          style={{ width: width || "100%", aspectRatio: aspect, borderRadius: 13.4 }}
          contentFit="cover"
          transition={150}
          recyclingKey={urls[0]}
          blurRadius={revealed ? 0 : 40}
          autoplay={autoplay}
        />
        </Pressable>
      </View>
    );
  }
  return (
    <View className="flex-row flex-wrap gap-1" style={{ maxWidth: 324 }}>
      {urls.map((url, i) => (
        <Pressable key={url} onPress={() => (revealed ? onOpen(i) : setRevealed(true))} accessibilityLabel={`Image ${i + 1} of ${urls.length}`}>
          <Image
            source={serverImage(url)}
            style={{ width: 160, height: 160, borderRadius: 13.4 }}
            contentFit="cover"
            recyclingKey={url}
            blurRadius={revealed ? 0 : 40}
            autoplay={autoplay}
          />
        </Pressable>
      ))}
    </View>
  );
}

function InlineVideo({ url }: { url: string }) {
  const [started, setStarted] = useState(false);
  // The player only exists once asked for: a long timeline of clips must not
  // open a decoder for each.
  if (!started) {
    return (
      <Pressable onPress={() => setStarted(true)} accessibilityRole="button" accessibilityLabel="Play video" className="items-center justify-center overflow-hidden rounded-lg bg-black" style={{ width: "100%", maxWidth: 320, aspectRatio: 16 / 9 }}>
        <View className="h-12 w-12 items-center justify-center rounded-full bg-white/20">
          <Play size={22} color="#fff" fill="#fff" />
        </View>
        <T className="absolute bottom-1.5 left-2 text-[11px] text-white/80" numberOfLines={1}>
          {fileName(url)}
        </T>
      </Pressable>
    );
  }
  return <Player url={url} />;
}

function Player({ url }: { url: string }) {
  const player = useVideoPlayer({ uri: serverAsset(url)!, headers: authHeaders() }, (p) => {
    p.play();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      allowsPictureInPicture
      contentFit="contain"
      style={{ width: "100%", maxWidth: 320, aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: "#000" }}
    />
  );
}

function AudioRow({ url }: { url: string }) {
  const player = useAudioPlayer({ uri: serverAsset(url)!, headers: authHeaders() });
  const status = useAudioPlayerStatus(player);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const progress = status.duration ? status.currentTime / status.duration : 0;
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2" style={{ maxWidth: 320 }}>
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause" : "Play"}
        className="h-9 w-9 items-center justify-center rounded-full bg-primary"
      >
        <Icon as={status.playing ? Pause : Play} tone="primary-foreground" size={16} />
      </Pressable>
      <View className="flex-1 gap-1">
        <T className="text-xs" numberOfLines={1}>
          {fileName(url)}
        </T>
        <View className="h-1 overflow-hidden rounded-full bg-muted">
          <View className="h-1 bg-primary" style={{ width: `${Math.round(progress * 100)}%` }} />
        </View>
        <T className="text-[10px] text-muted-foreground">
          {fmt(status.currentTime)} / {fmt(status.duration || 0)}
        </T>
      </View>
    </View>
  );
}

function FileCard({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      onPress={async () => {
        setBusy(true);
        try {
          await saveServerFile(url, fileName(url));
        } finally {
          setBusy(false);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={`File ${fileName(url)}, tap to open`}
      // FileAttachmentCard: the name without its extension, then the kind.
      className={cn("mt-1 flex-row items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5 active:bg-secondary/50", busy && "opacity-60")}
      style={{ maxWidth: 384 }}
    >
      <Icon as={FileText} size={35} />
      <View className="min-w-0 flex-1">
        <T className="text-sm font-medium" numberOfLines={1}>
          {fileName(url).replace(/\.[^.]+$/, "")}
        </T>
        <T className="text-xs text-muted-foreground" numberOfLines={1}>
          {fileKind(url)}
        </T>
      </View>
      <Icon as={Download} size={17} />
    </Pressable>
  );
}

function YouTubeCard({ id }: { id: string }) {
  return (
    <Pressable onPress={() => void Linking.openURL(`https://www.youtube.com/watch?v=${id}`)} accessibilityRole="link" accessibilityLabel="YouTube video" className="overflow-hidden rounded-lg" style={{ width: "100%", maxWidth: 320, aspectRatio: 16 / 9 }}>
      <Image source={{ uri: `https://img.youtube.com/vi/${id}/hqdefault.jpg` }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
      <View className="absolute inset-0 items-center justify-center">
        <View className="h-12 w-16 items-center justify-center rounded-xl bg-[#ff0000]">
          <Play size={22} color="#fff" fill="#fff" />
        </View>
      </View>
    </Pressable>
  );
}

/** "PDF file", "TXT file": the extension, as the web's card says it. */
function fileKind(url: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName(url))?.[1];
  return ext ? `${ext.toUpperCase()} file` : "File";
}
