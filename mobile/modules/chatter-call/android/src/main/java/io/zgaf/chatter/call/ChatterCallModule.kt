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
  private val pip = PictureInPicture { active -> sendEvent("onPipChanged", mapOf("active" to active)) }

  override fun definition() = ModuleDefinition {
    Name("ChatterCall")

    Events("onCallAction", "onAudioRoutesChanged", "onPipChanged")

    OnCreate {
      CallService.onAction = { action -> sendEvent("onCallAction", mapOf("action" to action)) }
      Telecom.onAction = { action ->
        if (action == "resume") router?.reclaim()
        sendEvent("onCallAction", mapOf("action" to action))
      }
      enableScreenCaptureService()
    }

    OnActivityEntersForeground { pip.attach(appContext.currentActivity) }

    OnActivityDestroys { pip.detach() }

    OnDestroy {
      pip.detach()
      CallService.onAction = null
      Telecom.onAction = null
      Telecom.stop()
      router?.stop()
      router = null
      proximity?.release()
      proximity = null
    }

    /** Begin a call: the notification, the locks, and the audio route. */
    Function("startCall") { title: String, text: String, muted: Boolean ->
      CallService.startedAt = System.currentTimeMillis()
      startService(title, text, muted)
      Telecom.start(context, title)
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
      Telecom.rename(title)
    }

    Function("stopCall") {
      context.stopService(Intent(context, CallService::class.java))
      Telecom.stop()
      router?.stop()
      proximity?.release()
    }

    Function("getAudioRoutes") {
      router?.routes() ?: emptyList<Map<String, Any>>()
    }

    Function("setAudioRoute") { id: String ->
      router?.choose(id)
    }

    /** While a stream is on screen, leaving the app takes it along in a small window. */
    Function("setAutoPictureInPicture") { enabled: Boolean, width: Int, height: Int ->
      val activity = appContext.currentActivity ?: return@Function
      pip.attach(activity)
      pip.setAuto(activity, enabled, width, height)
    }

    Function("enterPictureInPicture") { width: Int, height: Int ->
      val activity = appContext.currentActivity ?: return@Function false
      pip.attach(activity)
      pip.enter(activity, width, height)
    }

    Function("isInPictureInPicture") {
      pip.isActive(appContext.currentActivity)
    }
  }

  /**
   * Sharing the screen needs a foreground service of the media-projection
   * type running before the capture starts (Android 14+). react-native-webrtc
   * brings one, but only starts it when told to — an option apps usually set
   * in MainApplication, which is generated here. Set from here instead, by
   * name, so this module does not have to build against the library.
   */
  private fun enableScreenCaptureService() {
    try {
      val options = Class.forName("com.oney.WebRTCModule.WebRTCModuleOptions")
      val instance = options.getMethod("getInstance").invoke(null)
      options.getField("enableMediaProjectionService").setBoolean(instance, true)
    } catch (e: Exception) {
      android.util.Log.w("ChatterCall", "screen sharing will not have its capture service", e)
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
