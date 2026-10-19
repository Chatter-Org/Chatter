package io.zgaf.chatter.call

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The call's native side, for JavaScript: the foreground service that keeps
 * it running (CallService) and the choice of speaker or headset (AudioRouter).
 */
class ChatterCallModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) { "no React context" }

  private var router: AudioRouter? = null
  private var proximity: ProximityLock? = null

  override fun definition() = ModuleDefinition {
    Name("ChatterCall")

    Events("onCallAction", "onAudioRoutesChanged")

    OnCreate {
      CallService.onAction = { action -> sendEvent("onCallAction", mapOf("action" to action)) }
    }

    OnDestroy {
      CallService.onAction = null
      router?.stop()
      router = null
      proximity?.release()
      proximity = null
    }

    /** Begin a call: the notification, the locks, and the audio route. */
    Function("startCall") { title: String, text: String, muted: Boolean ->
      CallService.startedAt = System.currentTimeMillis()
      startService(title, text, muted)
      val r = router ?: AudioRouter(context) {
        sendEvent("onAudioRoutesChanged", mapOf("routes" to router?.routes()))
        // The earpiece means the phone is at an ear: dark against it.
        val ear = router?.onEarpiece() == true
        (proximity ?: ProximityLock(context).also { proximity = it }).hold(ear)
      }.also { router = it }
      r.start()
    }

    /** The call changed (a different channel, mute): redraw its notification. */
    Function("updateCall") { title: String, text: String, muted: Boolean ->
      startService(title, text, muted)
    }

    Function("stopCall") {
      context.stopService(Intent(context, CallService::class.java))
      router?.stop()
      proximity?.release()
    }

    Function("getAudioRoutes") {
      router?.routes() ?: emptyList<Map<String, Any>>()
    }

    Function("setAudioRoute") { id: String ->
      router?.choose(id)
    }
  }

  private fun startService(title: String, text: String, muted: Boolean) {
    val intent = Intent(context, CallService::class.java)
      .putExtra(CallService.EXTRA_TITLE, title)
      .putExtra(CallService.EXTRA_TEXT, text)
      .putExtra(CallService.EXTRA_MUTED, muted)
    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (e: Exception) {
      // Not allowed from the background on newer Android; the call goes on
      // without its notification until the app is next in front.
      android.util.Log.w("ChatterCall", "could not start the call service", e)
    }
  }
}
