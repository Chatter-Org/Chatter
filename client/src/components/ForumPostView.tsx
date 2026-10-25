import { useState, useEffect, useRef, useCallback } from "react";
import { useAppContext } from "@/lib/store";
import {
  apiGetForumPost,
  apiCreateForumComment,
  apiDeleteForumComment,
  apiEditForumPost,
  apiEditForumComment,
  apiUploadFile,
  forumImages,
  forumVideos,
  forumFiles,
  type ForumPost,
  type ForumComment,
} from "@/lib/api";
import { Button } from "@/components/ui/button"
import { cn, displayUserId } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Trash2, Paperclip, X, Send, Pencil, Check,
  CornerUpLeft, ChevronDown, ChevronRight, MessageSquare, ArrowUpDown, Tag,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ForumReactions } from "@/components/ForumReactions";
import {
  FORUM_EVENTS,
  applyForumThreadEvent,
  type ForumEventDetail,
  type ForumThreadState,
} from "@chatter/core/forum";
import { ForumTagList, ForumTagPicker } from "@/components/ForumTags";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { MentionMenu } from "@/components/MentionMenu";
import { useTextareaMentions } from "@/hooks/useTextareaMentions";
import { ForumMediaGallery, StagedForumFile } from "@/components/ForumMediaGallery";
import { usePendingFiles, MAX_ATTACHMENTS } from "@/hooks/usePendingFiles";
import {
  buildCommentThread, countReplies, loadThreadOrder, storeThreadOrder,
  MAX_THREAD_INDENT, type ForumCommentNode, type ThreadOrder,
} from "@/lib/forumThread";
import { sortForumAttachments } from "@/lib/mediaTypes";
import { useUploadQueue } from "@/hooks/useUploadQueue";
import { clipboardFiles } from "@/lib/clipboardFiles";
import { UploadProgressOverlay } from "@/components/UploadProgressOverlay";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { scrollBehavior } from "@/lib/theme/display";

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

interface ForumPostViewProps {
  roomId: string;
  postId: string;
  onBack: () => void;
}

export function ForumPostView({ roomId, postId, onBack }: ForumPostViewProps) {
  const confirm = useConfirm();
  const { state } = useAppContext();
  const [post, setPost] = useState<ForumPost | null>(null);
  // The tags the post's channel offers, kept live by the channel update.
  const postChannel = state.channels.find((c) => c.channel_id === post?.channel_id);
  const channelTags = postChannel?.forum_tags ?? [];
  // Whoever curates the forum — the people who may pin in it — may retag
  // anyone's post, though not change its words. The server checks the same.
  const canRetag =
    !!state.myPermissions?.manage_channels ||
    !!state.myPermissions?.manage_forum_posts ||
    (post?.channel_id
      ? postChannel?.created_by === state.userId
      : state.roomInfoMap[roomId]?.creator === state.userId);
  const [comments, setComments] = useState<ForumComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const commentMentions = useTextareaMentions(setCommentBody);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  /** The comment being answered, or null to answer the post itself. */
  const [replyingTo, setReplyingTo] = useState<ForumComment | null>(null);
  /** Comment ids whose replies are folded away. */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // The discussion is meant to sit behind the post, not compete with it, so it
  // is one fold away — open by default, because hidden is not the same as
  // secondary.
  const [discussionOpen, setDiscussionOpen] = useState(true);
  /** Which way round the thread reads. Held across posts and sessions. */
  const [threadOrder, setThreadOrder] = useState<ThreadOrder>(loadThreadOrder);
  /** A comment just posted from here, to be scrolled to once it lands. */
  const [landingCommentId, setLandingCommentId] = useState<string | null>(null);

  // Edit state for post
  const [editingPost, setEditingPost] = useState(false);
  const [editPostTitle, setEditPostTitle] = useState("");
  const [editPostBody, setEditPostBody] = useState("");
  const editPostMentions = useTextareaMentions(setEditPostBody);
  const [editPostTags, setEditPostTags] = useState<string[]>([]);
  // A curator retagging someone else's post: only the picker is offered.
  const [retaggingPost, setRetaggingPost] = useState(false);
  const [savingPost, setSavingPost] = useState(false);

  // Edit state for comments (keyed by comment_id)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");
  const editCommentMentions = useTextareaMentions(setEditCommentBody);
  const [savingComment, setSavingComment] = useState(false);

  const {
    files: commentImages,
    addMany: addCommentImages,
    remove: removeCommentImage,
    clear: clearCommentImages,
    remaining: commentImagesRemaining,
  } = usePendingFiles();
  const { progress: uploadProgress, uploadAll, reset: resetUploadProgress } = useUploadQueue();

  const stageCommentImages = useCallback((incoming: File[]) => {
    // Any file goes: pictures and clips land in the gallery, the rest are
    // downloads.
    const pictures = incoming;
    // Checked here rather than on submit: uploads run one after another, so an
    // image the server will refuse would otherwise be found out only after the
    // ones before it had already been sent.
    const limit = state.uploadLimitBytes;
    const small = limit > 0 ? pictures.filter((f) => f.size <= limit) : pictures;
    const tooBig = pictures.length - small.length;
    if (tooBig > 0) {
      const mb = Math.round(limit / 1024 / 1024);
      toast.error(
        tooBig === 1
          ? `That file is over the ${mb} MB limit`
          : `${tooBig} files are over the ${mb} MB limit`,
      );
    }
    if (small.length === 0) return;
    const { rejected } = addCommentImages(small);
    if (rejected > 0) {
      toast.error(
        `A comment holds ${MAX_ATTACHMENTS} files — ${rejected} ${rejected === 1 ? "was" : "were"} left off`,
      );
    }
  }, [addCommentImages, state.uploadLimitBytes]);

  // Owners and moderators hold this too; the server checks it per channel.
  const canManagePosts = !!state.myPermissions?.manage_forum_posts;

  const loadPost = useCallback(async () => {
    try {
      const data = await apiGetForumPost(roomId, postId);
      setPost(data.post);
      setComments(data.comments);
    } catch {
      // Post may have been deleted
    }
  }, [roomId, postId]);

  useEffect(() => {
    loadPost();
  }, [loadPost]);

  // Listen for real-time events; how each changes the post is the shared
  // core's (forum.ts).
  const threadRef = useRef<ForumThreadState>({ post, comments });
  threadRef.current = { post, comments };
  useEffect(() => {
    const listeners = FORUM_EVENTS.map((type) => {
      const listener = (e: Event) => {
        const detail = (e as CustomEvent).detail as ForumEventDetail;
        const next = applyForumThreadEvent(threadRef.current, type, detail, postId);
        if (next.gone) {
          onBack();
          return;
        }
        if (next === threadRef.current) return;
        threadRef.current = next;
        setPost(next.post);
        setComments(next.comments);
      };
      window.addEventListener(type, listener);
      return [type, listener] as const;
    });
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    };
  }, [postId, onBack]);

  // Take the writer to what they just wrote. Scrolling to the end of the list
  // was right while every comment was appended there; a reply is threaded in
  // beside its parent instead, and may be nowhere near the bottom.
  useEffect(() => {
    if (!landingCommentId) return;
    if (!comments.some((c) => c.comment_id === landingCommentId)) return;
    const el = document.getElementById(`forum-comment-${landingCommentId}`);
    el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    setLandingCommentId(null);
  }, [landingCommentId, comments]);

  const startReply = useCallback((comment: ForumComment) => {
    setReplyingTo(comment);
    setDiscussionOpen(true);
    // Focused rather than merely shown: the composer is at the far end of the
    // page from a reply button deep in a thread.
    requestAnimationFrame(() => commentInputRef.current?.focus());
  }, []);

  const toggleFold = useCallback((commentId: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(commentId)) next.add(commentId);
      return next;
    });
  }, []);

  const handleSubmitComment = async () => {
    if (!commentBody.trim() && commentImages.length === 0) return;
    setSubmitting(true);
    try {
      // Uploaded in the order they were staged, then split by kind: the post
      // and the comment keep pictures and clips in separate lists because they
      // are laid out differently, not because they were added separately.
      // Progress lands on the staged tiles, which stay up until this is done.
      const outcomes = await uploadAll(commentImages, async (file, onProgress) => {
        const { url } = await apiUploadFile(file, onProgress);
        return url;
      });
      const failed = outcomes.filter((o) => o.url === null);
      if (failed.length > 0) {
        // Posting the rest would quietly drop the others; everything is still
        // staged, so the comment can go again as it stands.
        toast.error(
          failed.length === 1
            ? `${failed[0].file.file.name} could not be uploaded`
            : `${failed.length} files could not be uploaded`,
        );
        return;
      }
      const { imageUrls, videoUrls, fileUrls } = sortForumAttachments(
        outcomes.map((o) => ({ file: o.file.file, url: o.url! })),
      );
      // The server wants a body; a comment that is only media says so.
      const count = imageUrls.length + videoUrls.length + fileUrls.length;
      const body =
        commentBody.trim() ||
        (count > 1 ? `(${count} attachments)` : count === 1 ? "(attachment)" : "");
      const { comment_id } = await apiCreateForumComment(
        roomId,
        postId,
        body,
        imageUrls,
        videoUrls,
        replyingTo?.comment_id,
        fileUrls,
      );
      setCommentBody("");
      clearCommentImages();
      resetUploadProgress();
      setReplyingTo(null);
      // A reply lands wherever its parent is, which is rarely the bottom.
      setLandingCommentId(comment_id);
    } catch (e: any) {
      toast.error(e.message || "Failed to post comment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!(await confirm({ title: "Delete this comment?", confirmLabel: "Delete", destructive: true }))) return;
    try {
      await apiDeleteForumComment(roomId, postId, commentId);
    } catch (e: any) {
      toast.error(e.message || "Failed to delete comment");
    }
  };

  const handleCommentImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    stageCommentImages(picked);
  };

  // Dropping images onto the comment box, the same as everywhere else.
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    stageCommentImages(Array.from(e.dataTransfer.files ?? []));
  };

  // Post editing
  const startEditingPost = () => {
    if (!post) return;
    setEditPostTitle(post.title);
    setEditPostBody(post.body);
    // Only tags the channel still offers: one it dropped could not be saved.
    setEditPostTags((post.tags ?? []).filter((id) => channelTags.some((t) => t.tag_id === id)));
    setEditingPost(true);
  };

  const cancelEditingPost = () => {
    setEditingPost(false);
    setEditPostTitle("");
    setEditPostBody("");
  };

  const saveEditPost = async () => {
    if (!post || !editPostTitle.trim()) return;
    setSavingPost(true);
    try {
      await apiEditForumPost(roomId, postId, editPostTitle.trim(), editPostBody, editPostTags);
      setEditingPost(false);
    } catch (e: any) {
      toast.error(e.message || "Failed to edit post");
    } finally {
      setSavingPost(false);
    }
  };

  const startRetaggingPost = () => {
    if (!post) return;
    setEditPostTags((post.tags ?? []).filter((id) => channelTags.some((t) => t.tag_id === id)));
    setRetaggingPost(true);
  };

  const saveRetagPost = async () => {
    if (!post) return;
    setSavingPost(true);
    try {
      await apiEditForumPost(roomId, postId, undefined, undefined, editPostTags);
      setRetaggingPost(false);
    } catch (e) {
      toast.error((e instanceof Error && e.message) || "Failed to change tags");
    } finally {
      setSavingPost(false);
    }
  };

  // Comment editing
  const startEditingComment = (comment: ForumComment) => {
    setEditingCommentId(comment.comment_id);
    setEditCommentBody(comment.body);
  };

  const cancelEditingComment = () => {
    setEditingCommentId(null);
    setEditCommentBody("");
  };

  const saveEditComment = async (commentId: string) => {
    if (!editCommentBody.trim()) return;
    setSavingComment(true);
    try {
      await apiEditForumComment(roomId, postId, commentId, editCommentBody.trim());
      setEditingCommentId(null);
      setEditCommentBody("");
    } catch (e: any) {
      toast.error(e.message || "Failed to edit comment");
    } finally {
      setSavingComment(false);
    }
  };

  if (!post) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  const authorDisplay = displayUserId(post.author);
  const isPostAuthor = post.author === state.userId;

  const thread = buildCommentThread(comments, threadOrder);

  /**
   * One comment and everything hanging off it.
   *
   * A plain recursive function rather than a component: every branch needs the
   * edit, fold and reply state this closure already has, and threading a dozen
   * callbacks down an arbitrarily deep tree buys nothing.
   */
  function renderComment(node: ForumCommentNode) {
    const comment = node.comment;
    const replyCount = countReplies(node);
    const isFolded = folded.has(comment.comment_id);
    const isEditing = editingCommentId === comment.comment_id;
    const isReplyTarget = replyingTo?.comment_id === comment.comment_id;
    const canDeleteComment = comment.author === state.userId || canManagePosts;
    const isCommentAuthor = comment.author === state.userId;
    // The post's author, answering in their own thread, is worth marking.
    const isThreadAuthor = comment.author === post!.author;

    return (
      <div key={comment.comment_id}>
        <div
          id={`forum-comment-${comment.comment_id}`}
          // No box: the tree lines are what group a reply with its parent,
          // and a frame round every comment drew a grid instead of a thread.
          // The reply being answered still stands out, as a wash.
          className={cn(
            "group rounded-md px-1.5 py-1 transition-colors",
            isReplyTarget && "bg-primary/5 ring-1 ring-primary/40",
          )}
        >
          {comment.deleted ? (
            // Kept only because replies hang off it; saying so beats a gap in
            // the thread where an answer's question used to be.
            <p className="ui-hint italic">Comment deleted</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{displayUserId(comment.author)}</span>
                {isThreadAuthor && (
                  <span className="rounded bg-secondary px-1 py-px text-3xs font-medium text-muted-foreground">
                    author
                  </span>
                )}
                <span className="ui-meta">
                  {formatTime(comment.created_at)}
                  {comment.edited && (
                    <span className="ml-1" title={comment.edited_at ? `Edited ${formatTime(comment.edited_at)}` : "Edited"}>
                      (edited)
                    </span>
                  )}
                </span>
                <div className="can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity ml-auto flex items-center gap-1">
                  {isCommentAuthor && !isEditing && (
                    <button
                      onClick={() => startEditingComment(comment)}
                      className="text-muted-foreground hover:text-foreground cursor-pointer"
                      title="Edit comment"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                  {canDeleteComment && (
                    <button
                      onClick={() => handleDeleteComment(comment.comment_id)}
                      className="text-muted-foreground hover:text-destructive cursor-pointer"
                      title="Delete comment"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {isEditing ? (
                <div className="mt-1 space-y-2">
                  <div className="relative">
                    {editCommentMentions.open && (
                      <MentionMenu
                        matches={editCommentMentions.matches}
                        selectedIdx={editCommentMentions.selectedIdx}
                        onSelect={editCommentMentions.complete}
                      />
                    )}
                    <Textarea
                      value={editCommentBody}
                      onChange={editCommentMentions.onChange}
                      onBlur={editCommentMentions.close}
                      maxLength={2000}
                      rows={2}
                      className="min-h-[40px] max-h-[120px] resize-none text-sm"
                      onKeyDown={(e) => {
                        if (editCommentMentions.onKeyDown(e)) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveEditComment(comment.comment_id);
                        }
                        if (e.key === "Escape") cancelEditingComment();
                      }}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveEditComment(comment.comment_id)} disabled={savingComment || !editCommentBody.trim()} className="h-7 text-xs gap-1">
                      <Check className="w-3 h-3" />
                      {savingComment ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancelEditingComment} className="h-7 text-xs">
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <ForumMarkdown content={comment.body} className="text-sm mt-1" />
              )}

              <ForumMediaGallery
                images={forumImages(comment)}
                videos={forumVideos(comment)}
                files={forumFiles(comment)}
                className="mt-2"
                compact
              />
            </>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            {!comment.deleted && (
              <button
                onClick={() => startReply(comment)}
                className="flex items-center gap-1 text-3xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <CornerUpLeft className="w-3 h-3" />
                Reply
              </button>
            )}
            {replyCount > 0 && (
              <button
                onClick={() => toggleFold(comment.comment_id)}
                className="flex items-center gap-1 text-3xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                {isFolded ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </button>
            )}
            {!comment.deleted && (
              <ForumReactions
                targetId={comment.comment_id}
                initial={comment.reactions}
                compact
                revealAdd
              />
            )}
          </div>
        </div>

        {node.replies.length > 0 && !isFolded && (
          // Tree lines: a trunk down from the parent and an elbow into each
          // reply. The trunk is drawn per reply rather than as one border so
          // it can stop at the last one instead of running on past it.
          //
          // The steps shrink after a few levels: a long back-and-forth would
          // otherwise walk off the right of a phone, and by then the lines say
          // less than the reply button did.
          <div className={cn("mt-1 space-y-1", node.depth < MAX_THREAD_INDENT ? "ml-3" : "ml-1")}>
            {node.replies.map((child, i) => {
              const deep = node.depth >= MAX_THREAD_INDENT;
              return (
                <div key={child.comment.comment_id} className={cn("relative", deep ? "pl-3" : "pl-5")}>
                  {i < node.replies.length - 1 && (
                    <span aria-hidden className="absolute left-0 -top-1 -bottom-1 border-l-3 border-border" />
                  )}
                  <span
                    aria-hidden
                    className={cn(
                      // Starts in the gap above, so it meets the trunk; ends level with
                      // the author line (py-1 plus half a text-xs line).
                      "absolute left-0 -top-1 h-4 rounded-bl-lg border-b-3 border-l-3 border-border",
                      deep ? "w-2.5" : "w-4",
                    )}
                  />
                  {renderComment(child)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 md:px-4 py-1.5 md:py-2 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3 md:p-4 space-y-4">
          {/* Post title & meta */}
          {editingPost ? (
            <div className="space-y-3">
              <Input
                value={editPostTitle}
                onChange={(e) => setEditPostTitle(e.target.value)}
                maxLength={200}
                placeholder="Post title"
              />
              <div className="relative">
                {editPostMentions.open && (
                  <MentionMenu
                    matches={editPostMentions.matches}
                    selectedIdx={editPostMentions.selectedIdx}
                    onSelect={editPostMentions.complete}
                  />
                )}
                <Textarea
                  value={editPostBody}
                  onChange={editPostMentions.onChange}
                  onKeyDown={editPostMentions.onKeyDown}
                  onBlur={editPostMentions.close}
                  maxLength={4000}
                  rows={4}
                  placeholder="Post body..."
                />
              </div>
              <ForumTagPicker tags={channelTags} value={editPostTags} onChange={setEditPostTags} />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEditPost} disabled={savingPost || !editPostTitle.trim()} className="gap-1.5">
                  <Check className="w-3 h-3" />
                  {savingPost ? "Saving..." : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditingPost}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-start gap-2">
                <h1 className="text-xl md:text-2xl font-bold leading-tight flex-1 min-w-0 break-words">{post.title}</h1>
                {isPostAuthor && (
                  <button
                    onClick={startEditingPost}
                    className="text-muted-foreground hover:text-foreground transition-colors mt-1 cursor-pointer"
                    title="Edit post"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
                {!isPostAuthor && canRetag && channelTags.length > 0 && !retaggingPost && (
                  <button
                    onClick={startRetaggingPost}
                    className="text-muted-foreground hover:text-foreground transition-colors mt-1 cursor-pointer"
                    title="Edit tags"
                  >
                    <Tag className="w-4 h-4" />
                  </button>
                )}
              </div>
              {retaggingPost ? (
                <div className="mt-2 space-y-2">
                  <ForumTagPicker tags={channelTags} value={editPostTags} onChange={setEditPostTags} />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveRetagPost} disabled={savingPost} className="gap-1.5">
                      <Check className="w-3 h-3" />
                      {savingPost ? "Saving..." : "Save tags"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRetaggingPost(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2">
                  <ForumTagList tagIds={post.tags} tags={channelTags} />
                </div>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                {authorDisplay} · {formatTime(post.created_at)}
                {post.edited && (
                  <span className="ml-1" title={post.edited_at ? `Edited ${formatTime(post.edited_at)}` : "Edited"}>
                    (edited)
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Post body, then its pictures — the post is what the page is for,
              so it gets the room and reads in the order an article does. */}
          {!editingPost && post.body && (
            <ForumMarkdown content={post.body} className="text-base leading-relaxed" />
          )}
          {!editingPost && (
            <ForumMediaGallery
              images={forumImages(post)}
              videos={forumVideos(post)}
              files={forumFiles(post)}
            />
          )}

          <ForumReactions targetId={post.post_id} initial={post.reactions} />

          {/* Discussion — behind the post, not beside it: a rule, a quieter
              heading, and a fold, so the page is the post first. */}
          <div className="border-t pt-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDiscussionOpen((open) => !open)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                {discussionOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                <MessageSquare className="w-3.5 h-3.5" />
                Discussion
                <span className="tabular-nums">{comments.length}</span>
              </button>
              {/* Beside the fold rather than inside it: a control for a list
                  you cannot see is a control that does nothing. */}
              {discussionOpen && comments.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 text-xs text-muted-foreground">
                      <ArrowUpDown className="w-3.5 h-3.5" />
                      {threadOrder === "newest" ? "Newest first" : "Oldest first"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {(["oldest", "newest"] as ThreadOrder[]).map((order) => (
                      <DropdownMenuItem
                        key={order}
                        onClick={() => {
                          setThreadOrder(order);
                          storeThreadOrder(order);
                        }}
                        className={threadOrder === order ? "font-semibold" : ""}
                      >
                        {order === "newest" ? "Newest first" : "Oldest first"}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            {discussionOpen && (
              <div className="mt-3 space-y-2">
                {thread.length === 0 && (
                  <p className="ui-hint py-2">
                    Nothing here yet. Say the first thing.
                  </p>
                )}
                {thread.map(renderComment)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Comment input */}
      <div
        className={cn(
          "border-t p-2 md:p-3 shrink-0 transition-colors",
          dragging && "outline-2 outline-dashed outline-primary -outline-offset-2 bg-primary/5",
        )}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div>
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-xs">
              <CornerUpLeft className="w-3 h-3 shrink-0 text-primary" />
              <span className="shrink-0">
                Replying to <span className="font-medium">{displayUserId(replyingTo.author)}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {replyingTo.body}
              </span>
              <button
                onClick={() => setReplyingTo(null)}
                className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                title="Reply to the post instead"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {commentImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {commentImages.map((pending, i) => (
                <div key={pending.id} className="relative">
                  <StagedForumFile
                    file={pending.file}
                    previewUrl={pending.previewUrl}
                    className="h-16 w-16"
                  />
                  <UploadProgressOverlay progress={uploadProgress[pending.id]} />
                  {!submitting && (
                    <button
                      onClick={() => removeCommentImage(i)}
                      className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground cursor-pointer"
                      title={`Remove ${pending.file.name}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1 md:gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleCommentImageSelect}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={commentImagesRemaining === 0}
              onClick={() => fileInputRef.current?.click()}
              title={
                commentImagesRemaining > 0
                  ? `Add files (${commentImagesRemaining} of ${MAX_ATTACHMENTS} left)`
                  : `${MAX_ATTACHMENTS} files is the limit`
              }
            >
              <Paperclip className="w-4 h-4" />
            </Button>
            <div className="relative flex-1 min-w-0">
              {commentMentions.open && (
                <MentionMenu
                  matches={commentMentions.matches}
                  selectedIdx={commentMentions.selectedIdx}
                  onSelect={commentMentions.complete}
                />
              )}
              <Textarea
                ref={commentInputRef}
                placeholder={replyingTo ? `Reply to ${displayUserId(replyingTo.author)}…` : "Write a comment..."}
                value={commentBody}
                onChange={commentMentions.onChange}
                onBlur={commentMentions.close}
                onPaste={(e) => {
                  // A pasted screenshot is staged like a picked file; text
                  // pastes as usual.
                  const files = clipboardFiles(e);
                  if (files.length === 0) return;
                  e.preventDefault();
                  stageCommentImages(files);
                }}
                onKeyDown={(e) => {
                  if (commentMentions.onKeyDown(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitComment();
                  }
                }}
                className="min-h-[44px] md:min-h-[40px] max-h-[120px] resize-none"
                rows={1}
              />
            </div>
            <Button
              size="icon"
              className="shrink-0"
              onClick={handleSubmitComment}
              disabled={submitting || (!commentBody.trim() && commentImages.length === 0)}
            
            aria-label="Post comment">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
