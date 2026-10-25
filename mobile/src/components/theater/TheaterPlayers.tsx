import { forwardRef, useImperativeHandle, useRef } from "react";
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { WebView } from "react-native-webview";
import { currentServer, serverAsset, sessionHeaders } from "@/platform/server";
import type { TheaterPlayer } from "./sync";

/** What a player reports, for the sync to act on. */
export interface PlayerEvents {
  onReady(): void;
  onPosition(secs: number): void;
  onDuration(secs: number): void;
  onEnded(): void;
}

export interface TheaterPlayerHandle extends TheaterPlayer {
  setMuted(muted: boolean): void;
}

/**
 * An uploaded file, or any direct link: the session goes along as a header
 * to this server (one may only show uploads to its members), never elsewhere. No controls of its
 * own — the theater's are the room's.
 */
export const FilePlayer = forwardRef<TheaterPlayerHandle, PlayerEvents & { url: string }>(function FilePlayer(
  { url, onReady, onPosition, onDuration, onEnded },
  ref,
) {
  const uri = serverAsset(url) ?? url;
  const player = useVideoPlayer({ uri, headers: sessionHeaders(uri) }, (p) => {
    p.timeUpdateEventInterval = 0.5;
  });
  useImperativeHandle(
    ref,
    () => ({
      seek: (secs) => {
        player.currentTime = secs;
      },
      play: () => player.play(),
      pause: () => player.pause(),
      setMuted: (muted) => {
        player.muted = muted;
      },
    }),
    [player],
  );
  useEventListener(player, "statusChange", ({ status }) => {
    if (status !== "readyToPlay") return;
    // sourceLoad can come before this listener is attached; the length is known by now.
    onDuration(player.duration);
    onReady();
  });
  useEventListener(player, "sourceLoad", ({ duration }) => onDuration(duration));
  useEventListener(player, "timeUpdate", ({ currentTime }) => onPosition(currentTime));
  useEventListener(player, "playToEnd", onEnded);
  return <VideoView player={player} nativeControls={false} contentFit="contain" style={{ flex: 1, backgroundColor: "#000" }} />;
});

/** YouTube's own player (the IFrame API) on a page of its own, without its
 *  controls, reporting where it is twice a second. On youtube.com itself: told
 *  to use youtube-nocookie.com, as the web's embed does, the API addresses its
 *  messages to the wrong origin and never hears that the player is ready. */
function youTubePage(id: string, origin: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#p{margin:0;width:100%;height:100%;background:#000;overflow:hidden}</style></head>
<body><div id="p"></div>
<script>
var player;
function post(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}
function onYouTubeIframeAPIReady(){
  player=new YT.Player('p',{videoId:${JSON.stringify(id)},width:'100%',height:'100%',
    playerVars:{controls:0,disablekb:1,rel:0,playsinline:1,autoplay:0,origin:${JSON.stringify(origin)}},
    events:{
      onReady:function(){post({t:'ready',d:player.getDuration()});setInterval(function(){post({t:'pos',s:player.getCurrentTime(),d:player.getDuration()});},500);},
      onStateChange:function(e){if(e.data===0)post({t:'ended'});}
    }});
}
</script><script src="https://www.youtube.com/iframe_api"></script></body></html>`;
}

export const YouTubePlayer = forwardRef<TheaterPlayerHandle, PlayerEvents & { id: string }>(function YouTubePlayer(
  { id, onReady, onPosition, onDuration, onEnded },
  ref,
) {
  const web = useRef<WebView<object>>(null);
  const call = (js: string) => web.current?.injectJavaScript(`try{player&&${js}}catch(e){}true;`);
  useImperativeHandle(ref, () => ({
    seek: (secs) => call(`player.seekTo(${Number(secs) || 0},true)`),
    play: () => call("player.playVideo()"),
    pause: () => call("player.pauseVideo()"),
    setMuted: (muted) => call(muted ? "player.mute()" : "player.unMute()"),
  }));
  // YouTube wants to know which site is playing it: the server's, as on the web.
  const origin = currentServer();
  return (
    // The default props type parameter makes its props `never`.
    <WebView<object>
      ref={web}
      source={{ html: youTubePage(id, origin), baseUrl: origin }}
      style={{ flex: 1, backgroundColor: "#000" }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      javaScriptEnabled
      scrollEnabled={false}
      onMessage={(e) => {
        let msg: { t?: string; s?: number; d?: number };
        try {
          msg = JSON.parse(e.nativeEvent.data);
        } catch {
          return;
        }
        if (typeof msg.d === "number") onDuration(msg.d);
        if (msg.t === "ready") onReady();
        else if (msg.t === "pos" && typeof msg.s === "number") onPosition(msg.s);
        else if (msg.t === "ended") onEnded();
      }}
    />
  );
});
