import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Hash, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  apiGetPostableChannels,
  apiSendMessage,
  apiUploadFile,
  type PostableChannel,
} from "@/lib/api";

/** Long enough for a sentence, short enough to stay a caption. */
const MAX_CLIP_TITLE_LENGTH = 200;

export interface TakenClip {
  file: File;
  seconds: number;
}

/**
 * Where a clip goes. The footage is already captured when this opens, so
 * choosing takes as long as it likes without the moment sliding out of the
 * buffer; the upload waits for the choice, so a cancelled clip leaves nothing
 * on the server.
 *
 * The list is the server's answer, not the client's guess: it runs the checks
 * a send runs, so every channel offered is one that will accept the post.
 */
export function ClipChannelDialog({
  clip,
  roomId,
  defaultChannelId,
  onClose,
}: {
  clip: TakenClip | null;
  roomId: string | null;
  defaultChannelId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!clip && !!roomId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        {/* Mounted with the dialog, so every clip starts from a fresh fetch
            and a fresh choice. */}
        {clip && roomId && (
          <ClipChannelForm
            clip={clip}
            roomId={roomId}
            defaultChannelId={defaultChannelId}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClipChannelForm({
  clip,
  roomId,
  defaultChannelId,
  onClose,
}: {
  clip: TakenClip;
  roomId: string;
  defaultChannelId: string | null;
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<PostableChannel[] | null>(null);
  const [isDm, setIsDm] = useState(false);
  const [canPost, setCanPost] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [title, setTitle] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiGetPostableChannels(roomId)
      .then((res) => {
        if (cancelled) return;
        setChannels(res.channels);
        setIsDm(res.is_dm);
        setCanPost(res.can_post);
        // The channel being read is the likeliest destination; anything else
        // starts on the first one the user may post in.
        const preferred = res.channels.find((c) => c.channel_id === defaultChannelId);
        setSelected(preferred?.channel_id ?? res.channels[0]?.channel_id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load channels");
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, defaultChannelId]);

  const previewUrl = useMemo(() => URL.createObjectURL(clip.file), [clip.file]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  const ready = canPost && (isDm || !!selected) && !posting;

  const post = async () => {
    if (!ready) return;
    setPosting(true);
    try {
      const { url } = await apiUploadFile(clip.file);
      // The title goes on the line above the file, the way the composer sends
      // text with an attachment, so every client already renders it.
      const caption = title.trim();
      const body = caption ? `${caption}\n${url}` : url;
      await apiSendMessage(roomId, body, undefined, false, isDm ? undefined : selected ?? undefined);
      const where = isDm ? "" : ` to #${channels?.find((c) => c.channel_id === selected)?.name ?? "channel"}`;
      // Say the real length: before the buffer has filled it is shorter than
      // the setting, and silently posting a stub would look like a bug.
      toast.success(`Clip posted${where} (${Math.round(clip.seconds)}s)`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the clip");
      setPosting(false);
    }
  };

  let body: React.ReactNode;
  if (loadError) {
    body = <p className="text-sm text-destructive">{loadError}</p>;
  } else if (!channels) {
    body = (
      <div className="flex justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (isDm) {
    body = canPost ? (
      <p className="text-sm text-muted-foreground">The clip will be posted to this conversation.</p>
    ) : (
      <p className="text-sm text-muted-foreground">You cannot post files in this conversation.</p>
    );
  } else if (channels.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        There is no channel in this room you have permission to post files in.
      </p>
    );
  } else {
    body = (
      <div role="radiogroup" aria-label="Channel" className="max-h-64 overflow-y-auto -mx-1 px-1">
        {channels.map((ch, i) => {
          // The server sends them grouped, so a heading goes where the
          // category changes.
          const heading =
            ch.category_name !== channels[i - 1]?.category_name && ch.category_name;
          const active = ch.channel_id === selected;
          return (
            <div key={ch.channel_id}>
              {heading && (
                <div className="px-2 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {heading}
                </div>
              )}
              <button
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setSelected(ch.channel_id)}
                disabled={posting}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Hash className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{ch.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Post clip</DialogTitle>
        <DialogDescription>
          {Math.round(clip.seconds)}s captured. Give it a title and choose where to post it.
        </DialogDescription>
      </DialogHeader>
      <video
        src={previewUrl}
        controls
        muted
        playsInline
        className="w-full max-h-48 rounded-md bg-black"
      />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void post();
          }
        }}
        placeholder="Title (optional)"
        aria-label="Clip title"
        maxLength={MAX_CLIP_TITLE_LENGTH}
        disabled={posting}
        autoFocus
      />
      {body}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={posting}>
          Discard
        </Button>
        <Button onClick={post} disabled={!ready}>
          {posting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Post
        </Button>
      </DialogFooter>
    </>
  );
}
