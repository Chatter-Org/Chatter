import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { ArrowLeft, Pencil, Check, X, Paperclip, Trash2, Smile, Pin, ChevronDown, ChevronRight, Reply } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { apiSendThreadMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MessageItem } from "./MessageItem";
import { MentionMenu } from "./MentionMenu";
import {
  deleteImageBeforeCaret,
  emojiImage,
  getComposerText,
  insertAtCaret,
  insertTextAtCaret,
  replaceBeforeCaret,
  setComposerText,
  textBeforeCaret,
} from "@/lib/composer";
import { findMentionMatches } from "@/lib/mentions";
import { channelMentionMatches, encodeChannelLinks, plainChannelLinks, visibleChannels } from "@/lib/channelLinks";
import { displayUserId } from "@/lib/utils";
import { AuthAvatarImage } from "./AuthImage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmojiPicker, renderInlineEmojis } from "./EmojiPicker";
import { canManageMessages } from "@/lib/permissions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { PendingAttachments } from "./PendingAttachments";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import { OutgoingUploads } from "./OutgoingUploads";
import { enqueueOutgoing, useOutgoingUploads, type OutgoingTarget } from "@/lib/outgoingUploads";
import { scrollBehavior } from "@/lib/theme/display";

export function ThreadPanel() {
  const confirm = useConfirm();
  const { state, dispatch, closeThread, setThreadName, deleteThread, unpinMessage, loadOlderThreadMessages, revealThreadMessage } = useAppContext();
  const [body, setBody] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [pinsOpen, setPinsOpen] = useState(false);
  /** The "@word" being typed at the caret, or null when there is none. */
  const [mentionSearch, setMentionSearch] = useState<string | null>(null);
  // "@" offers people and roles, "#" offers channels; one menu serves both.
  const [mentionTrigger, setMentionTrigger] = useState<"@" | "#">("@");
  // The channels a "#name" can link to, which are the ones this user can see.
  const linkChannels = useMemo(
    () => visibleChannels(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.channels, state.userId, state.roomMembers, state.customRoles, state.memberCustomRoles],
  );
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const {
    files: pendingFiles,
    add: addStagedFile,
    remove: removePendingFile,
    clear: clearPendingFiles,
  } = usePendingFiles();
  const outgoing = useOutgoingUploads();
  const inputRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { threadRootMessage, threadMessages, threadReplyingTo, threadPins, userPresence, currentRoomId, roomInfoMap } = state;

  /** What to call this thread when its send is watched from somewhere else. */
  const threadLabel = threadRootMessage?.thread_name
    ? `“${threadRootMessage.thread_name}”`
    : "a thread";
  /** Where this composer posts, so its own batches are not labelled. */
  const here: OutgoingTarget | undefined =
    currentRoomId && state.activeThreadEventId
      ? { kind: "thread", roomId: currentRoomId, threadEventId: state.activeThreadEventId }
      : undefined;

  const roomCustomEmojis = currentRoomId ? (roomInfoMap[currentRoomId]?.custom_emojis ?? []) : [];
  const emojiAliases = currentRoomId ? (roomInfoMap[currentRoomId]?.emoji_aliases ?? {}) : {};

  // A thread opens on its newest page, at the bottom, and older pages are
  // prepended as the reader scrolls up — the way a channel reads. What the
  // effect below has to tell apart is *where* the replies changed: a new
  // thread, a page prepended above, or a reply arriving below.
  const seenRef = useRef<{ threadId: string | null; first?: string; last?: string }>({ threadId: null });
  /** The oldest loaded reply and how far it sat below the top of the panel,
   *  so a prepended page can be slid in above it without moving it. Kept on
   *  every scroll rather than at the moment a load starts: the reader can
   *  keep scrolling while the page is in flight. */
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);

  const recordAnchor = useCallback(() => {
    const el = scrollRef.current;
    const first = state.threadMessages[0]?.event_id;
    if (!el || !first) return;
    const node = el.querySelector(`[data-event-id="${first}"]`);
    if (!node) return;
    anchorRef.current = {
      id: first,
      offset: node.getBoundingClientRect().top - el.getBoundingClientRect().top,
    };
  }, [state.threadMessages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const seen = seenRef.current;
    const first = threadMessages[0]?.event_id;
    const last = threadMessages[threadMessages.length - 1]?.event_id;
    const threadId = state.activeThreadEventId;

    if (seen.threadId !== threadId) {
      el.scrollTop = el.scrollHeight;
    } else if (first !== seen.first && last === seen.last) {
      // A page went in above. Put the reply that was on top back where it
      // was, rather than leaving the scroll offset to jump the view.
      const anchor = anchorRef.current;
      const node = anchor && el.querySelector(`[data-event-id="${anchor.id}"]`);
      if (anchor && node) {
        const now = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += now - anchor.offset;
      }
    } else if (last !== seen.last) {
      // A new reply follows the conversation only for someone already at it,
      // or for its author — not for someone reading back through older pages.
      const newest = threadMessages[threadMessages.length - 1];
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (nearBottom || newest?.sender === state.userId) {
        messagesEndRef.current?.scrollIntoView({ behavior: scrollBehavior() });
      }
    }
    seenRef.current = { threadId, first, last };
    recordAnchor();

    // A first page too short to scroll can never be scrolled up from.
    if (state.threadHasMore && !state.threadLoadingOlder && el.scrollHeight <= el.clientHeight) {
      void loadOlderThreadMessages();
    }
  }, [threadMessages, state.activeThreadEventId, state.userId, state.threadHasMore, state.threadLoadingOlder, loadOlderThreadMessages, recordAnchor]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    recordAnchor();
    if (state.threadHasMore && !state.threadLoadingOlder && el.scrollTop < el.clientHeight) {
      void loadOlderThreadMessages();
    }
  }, [recordAnchor, state.threadHasMore, state.threadLoadingOlder, loadOlderThreadMessages]);

  // Starting a reply is aiming the composer, so put the cursor there.
  useEffect(() => {
    if (threadReplyingTo) inputRef.current?.focus();
  }, [threadReplyingTo]);

  const cancelReply = useCallback(() => {
    dispatch({ type: "SET_THREAD_REPLYING_TO", payload: null });
  }, [dispatch]);

  const handleSend = useCallback(async () => {
    const trimmed = encodeChannelLinks(body.trim(), linkChannels);
    if (!trimmed && pendingFiles.length === 0) return;
    // Read now rather than when the send resolves: a thread can be closed, or
    // another one opened, long before a large attachment has finished going
    // up, and the reply belongs to the thread it was written in.
    const roomId = state.currentRoomId;
    const threadEventId = state.activeThreadEventId;
    if (!roomId || !threadEventId) return;
    const replyTo = state.threadReplyingTo?.event_id;
    setBody("");
    setComposerText(inputRef.current, "");
    setMentionSearch(null);
    cancelReply();

    // A reply with files is handed to the outgoing queue whole, so closing the
    // thread — or the panel — does not take the upload with it.
    if (pendingFiles.length > 0) {
      const files = pendingFiles.map((staged) => staged.file);
      clearPendingFiles();
      enqueueOutgoing({
        target: { kind: "thread", roomId, threadEventId, replyTo },
        label: threadLabel,
        body: trimmed,
        files,
      });
      return;
    }

    try {
      await apiSendThreadMessage(roomId, threadEventId, trimmed, replyTo);
    } catch {
      // Matching the previous behaviour: a refused reply is reported by the
      // request layer, and the thread stays open.
    }
  }, [body, linkChannels, pendingFiles, clearPendingFiles, state.currentRoomId, state.activeThreadEventId, state.threadReplyingTo, threadLabel, cancelReply]);

  const mentionMatches = useMemo(
    () =>
      mentionSearch === null
        ? []
        : mentionTrigger === "#"
          ? channelMentionMatches(linkChannels, mentionSearch)
          : findMentionMatches(state, mentionSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mentionSearch, mentionTrigger, linkChannels, state.roomMembers, state.customRoles, state.currentRoomId, state.roomInfoMap],
  );

  /** Open the mention menu when the caret sits just after "@" or "@word", or
   *  the channel list after "#" or "#chan". */
  const detectMention = () => {
    const div = inputRef.current;
    const before = div ? textBeforeCaret(div) : null;
    const match = before === null ? null : /(?:^|\s)@(\w*)$/.exec(before);
    const channelMatch = before === null || match ? null : /(?:^|[\s(])#([^\s#@]*)$/.exec(before);
    setMentionTrigger(channelMatch ? "#" : "@");
    setMentionSearch(match ? match[1] : channelMatch ? channelMatch[1] : null);
    setSelectedMentionIdx(0);
  };

  const handleInput = () => {
    const div = inputRef.current;
    if (!div) return;
    // Emptied by hand, a contenteditable keeps a stray <br>, which would
    // hide the placeholder.
    if (getComposerText(div) === "" && !div.querySelector("img")) div.innerHTML = "";
    setBody(getComposerText(div));
    detectMention();
  };

  const completeMention = (name: string) => {
    const div = inputRef.current;
    if (!name || !div) return;
    const before = textBeforeCaret(div);
    const at = before?.lastIndexOf(mentionTrigger) ?? -1;
    if (at === -1) return;
    replaceBeforeCaret(div, at, `${mentionTrigger}${name} `);
    setMentionSearch(null);
    setBody(getComposerText(div));
    div.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mentionSearch !== null && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.min(i + 1, mentionMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        completeMention(mentionMatches[selectedMentionIdx]?.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionSearch(null);
        return;
      }
    }
    if (e.key === "Backspace" && inputRef.current && deleteImageBeforeCaret(inputRef.current)) {
      e.preventDefault();
      setBody(getComposerText(inputRef.current));
      return;
    }
    if (e.key === "Escape" && threadReplyingTo) {
      e.preventDefault();
      cancelReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertEmoji = useCallback((emoji: string) => {
    const div = inputRef.current;
    setEmojiOpen(false);
    if (!div) return;
    // A custom emoji arrives as its image URL, and goes in as the inline image
    // the channel composer uses; sent bare it would be a full-size picture.
    const isImageUrl = emoji.startsWith("/") || emoji.startsWith("http");
    insertAtCaret(div, isImageUrl ? emojiImage(emoji) : document.createTextNode(emoji));
    setBody(getComposerText(div));
    div.focus();
  }, []);


  /** Stage files on the composer; nothing is uploaded or sent until Send. */
  const stageFiles = useCallback((files: File[]) => {
    let staged = pendingFiles.length;
    for (const file of files) {
      if (state.uploadLimitBytes > 0 && file.size > state.uploadLimitBytes) {
        toast.error(`File "${file.name}" too large (max ${Math.round(state.uploadLimitBytes / 1024 / 1024)} MB)`);
        continue;
      }
      if (staged >= MAX_ATTACHMENTS) {
        toast.error(`You can attach at most ${MAX_ATTACHMENTS} files per message`);
        break;
      }
      addStagedFile(file);
      staged++;
    }
  }, [addStagedFile, pendingFiles.length, state.uploadLimitBytes]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const filesList = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (filesList.length > 0) stageFiles(filesList);
  }, [stageFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      stageFiles(files);
      return;
    }
    // Plain text only, but with emoji markers turned back into images.
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const div = inputRef.current;
    if (!text || !div) return;
    insertTextAtCaret(div, text);
    setBody(getComposerText(div));
    detectMention();
  }, [stageFiles]);

  // Drag-and-drop file upload
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      stageFiles(files);
    }
  }, [stageFiles]);

  const startEditingName = useCallback(() => {
    setNameDraft(threadRootMessage?.thread_name ?? "");
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [threadRootMessage?.thread_name]);

  const commitName = useCallback(async () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed === (threadRootMessage?.thread_name ?? "")) return;
    try {
      await setThreadName(trimmed);
    } catch {}
  }, [nameDraft, setThreadName, threadRootMessage?.thread_name]);

  const cancelEditName = useCallback(() => {
    setEditingName(false);
    setNameDraft("");
  }, []);

  if (!threadRootMessage) return null;

  const rootSender = userPresence[threadRootMessage.sender]?.displayName
    || displayUserId(threadRootMessage.sender);
  const rootAvatarUrl = userPresence[threadRootMessage.sender]?.avatarUrl;
  const rootInitial = rootSender.substring(0, 1).toUpperCase();
  const rootTime = new Date(threadRootMessage.origin_server_ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const myMember = state.roomMembers.find((m) => m.userId === state.userId);
  const threadOwnerMember = state.roomMembers.find((m) => m.userId === threadRootMessage.sender);
  const myRole = myMember?.role ?? "member";
  const threadOwnerRole = threadOwnerMember?.role ?? "member";
  const isThreadOwner = threadRootMessage.sender === state.userId;
  const canDelete =
    isThreadOwner ||
    (myRole === "owner" && threadOwnerRole !== "owner") ||
    (myRole === "moderator" && threadOwnerRole === "member");

  const handleDeleteThread = async () => {
    if (!(await confirm({ title: "Delete this thread?", description: "All replies will be deleted too.", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await deleteThread();
    } catch {}
  };

  // From the server, not the replies held: those are only the pages loaded.
  const replyCount = threadRootMessage?.thread_reply_count ?? threadMessages.length;
  const mayUnpin = canManageMessages(state);

  /** Bring a pinned reply into view in the thread, the way a reply quote does. */
  const jumpToPin = async (eventId: string) => {
    // A pin can be older than the pages loaded so far.
    if (!threadMessages.some((m) => m.event_id === eventId)) {
      if (!(await revealThreadMessage(eventId))) return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const el = document.querySelector(`[data-thread-panel] [data-event-id="${eventId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    el.classList.add("bg-accent");
    setTimeout(() => el.classList.remove("bg-accent"), 1500);
  };

  const handleUnpin = async (eventId: string) => {
    try {
      await unpinMessage(eventId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to unpin");
    }
  };

  return (
    <div
      className="relative flex flex-col border-border bg-background flex-1 min-h-0 min-w-0"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-md pointer-events-none">
          <div className="flex flex-col items-center gap-2">
            <Paperclip className="h-8 w-8 text-primary" />
            <span className="text-sm font-medium text-primary">Drop file to upload</span>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="group flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-sm shrink-0"
          onClick={closeThread}
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </Button>
        {canDelete && (
          <button
            onClick={handleDeleteThread}
            title="Delete thread"
            className="text-muted-foreground hover:text-destructive transition-colors shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {editingName ? (
            <>
              <input
                ref={nameInputRef}
                className="flex-1 min-w-0 text-sm font-semibold bg-transparent border-b border-primary outline-none"
                value={nameDraft}
                placeholder="Thread name…"
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") cancelEditName();
                }}
                maxLength={80}
              />
              <button onClick={commitName} title="Save" className="text-primary hover:text-primary/80 shrink-0">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button onClick={cancelEditName} title="Cancel" className="text-muted-foreground hover:text-foreground shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold truncate">
                {threadRootMessage.thread_name || "Thread"}
              </span>
              <button
                onClick={startEditingName}
                title="Set thread name"
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Thread participants */}
      {threadRootMessage.thread_participants && threadRootMessage.thread_participants.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 shrink-0">
          <span className="ui-heading shrink-0">
            Members
          </span>
          <div className="flex items-center -space-x-1.5 flex-wrap">
            {threadRootMessage.thread_participants.map((pid) => {
              const pName = userPresence[pid]?.displayName || displayUserId(pid);
              const pAvatar = userPresence[pid]?.avatarUrl;
              return (
                <Avatar key={pid} className="h-5 w-5 border-2 border-background" title={pName}>
                  <AuthAvatarImage src={pAvatar} />
                  <AvatarFallback className="text-3xs font-semibold bg-secondary">
                    {pName.substring(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              );
            })}
          </div>
          <span className="ui-meta">
            {threadRootMessage.thread_participants.length}
          </span>
        </div>
      )}

      {/* Pinned replies — collapsed by default so a thread with pins still
          opens on the conversation, not on a list about it. */}
      {threadPins.length > 0 && (
        <div className="border-b border-border/50 shrink-0">
          <button
            type="button"
            onClick={() => setPinsOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent/50 transition-colors"
          >
            {pinsOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <Pin className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="ui-heading">Pinned</span>
            <span className="ui-meta">{threadPins.length}</span>
          </button>
          {pinsOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {threadPins.map((pin) => {
                const pinSender = userPresence[pin.sender]?.displayName || displayUserId(pin.sender);
                return (
                  <div key={pin.event_id} className="group/pin flex items-start gap-2 px-3 py-1 hover:bg-accent/50">
                    <button
                      type="button"
                      onClick={() => void jumpToPin(pin.event_id)}
                      className="min-w-0 flex-1 text-left"
                      title="Jump to message"
                    >
                      <span className="text-xs font-semibold">{pinSender}</span>
                      <p className="text-xs text-muted-foreground truncate">
                        {pin.content.spoiler
                          ? <span className="italic">Spoiler message</span>
                          : renderInlineEmojis(plainChannelLinks(pin.content.body, linkChannels))}
                      </p>
                    </button>
                    {mayUnpin && (
                      <button
                        type="button"
                        onClick={() => handleUnpin(pin.event_id)}
                        title="Unpin message"
                        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground can-hover:opacity-0 can-hover:group-hover/pin:opacity-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Scrollable content */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto min-h-0" data-thread-panel>
        {/* Root message */}
        <div className="px-3 pt-3 pb-2 border-b border-border/50" data-event-id={threadRootMessage.event_id}>
          <div className="flex items-start gap-2">
            <Avatar className="h-7 w-7 mt-0.5 shrink-0">
              <AuthAvatarImage src={rootAvatarUrl} />
              <AvatarFallback className="text-xs font-semibold bg-secondary">
                {rootInitial}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-semibold truncate">{rootSender}</span>
                <span className="text-xs text-muted-foreground shrink-0">{rootTime}</span>
              </div>
              <p className="text-sm break-words [overflow-wrap:anywhere] whitespace-pre-wrap mt-0.5">
                {plainChannelLinks(threadRootMessage.content.body, linkChannels)}
              </p>
            </div>
            {/* The root is part of the conversation, so it can be answered
                like any reply. */}
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_THREAD_REPLYING_TO", payload: threadRootMessage })}
              title="Reply"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Reply className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Reply count divider */}
        {replyCount > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>
        )}

        {/* Thread messages */}
        <div className="pb-2">
          {state.threadLoadingOlder && (
            <p className="text-center text-xs text-muted-foreground py-2">Loading older replies...</p>
          )}
          {threadMessages.map((msg, i) => {
            const prevMsg = threadMessages[i - 1];
            const grouped =
              i > 0 &&
              prevMsg.sender === msg.sender &&
              msg.origin_server_ts - prevMsg.origin_server_ts < 5 * 60 * 1000;
            return (
              <MessageItem key={msg.event_id} message={msg} grouped={grouped} inThread />
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-border">
        {/* The single bar that stood here said which file it was under; with
            several going up it named them one after another too fast to read.
            Each tile carries its own now. */}
        <OutgoingUploads
          batches={outgoing.filter(
            (batch) =>
              batch.target.kind === "thread" &&
              batch.target.threadEventId === state.activeThreadEventId,
          )}
          here={here}
        />
        {threadReplyingTo && (
          <div className="mb-2 border-l-2 border-l-primary px-3 py-2 bg-accent/30 rounded-sm flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-primary">
                Replying to {userPresence[threadReplyingTo.sender]?.displayName || displayUserId(threadReplyingTo.sender)}
              </p>
              <p className="text-xs text-muted-foreground truncate inline-flex items-center gap-0.5">
                {threadReplyingTo.content.spoiler
                  ? <span className="italic">Spoiler message</span>
                  : renderInlineEmojis(plainChannelLinks(threadReplyingTo.content.body, linkChannels))}
              </p>
            </div>
            <button
              className="text-muted-foreground hover:text-foreground flex-shrink-0 cursor-pointer"
              onClick={cancelReply}
              title="Cancel reply"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <PendingAttachments files={pendingFiles} onRemove={removePendingFile} />
        <div className="relative flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
          {mentionSearch !== null && (
            <MentionMenu matches={mentionMatches} selectedIdx={selectedMentionIdx} onSelect={completeMention} />
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={handleFileSelect}
          />
          <button
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
            onClick={() => fileInputRef.current?.click()}
            title="Upload file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <div
            ref={inputRef}
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label="Reply in thread"
            data-placeholder="Reply in thread…"
            suppressContentEditableWarning
            className="flex-1 min-w-0 bg-transparent text-sm outline-none max-h-24 min-h-[1.25rem] overflow-y-auto break-words self-center empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none"
            style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: "20px" }}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => setMentionSearch(null)}
          />
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <button
                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                title="Emoji"
              >
                <Smile className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="w-auto p-0">
              <EmojiPicker
                onSelect={insertEmoji}
                roomCustomEmojis={roomCustomEmojis}
                emojiAliases={emojiAliases}
              />
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            className="h-7 px-2 shrink-0"
            // Nothing to wait for any more: a reply with files is handed to
            // the outgoing queue, so the composer is free straight away.
            disabled={!body.trim() && pendingFiles.length === 0}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
