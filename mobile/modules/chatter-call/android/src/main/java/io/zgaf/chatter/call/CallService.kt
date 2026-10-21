package io.zgaf.chatter.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps a voice call alive while the app is out of sight.
 *
 * Android stops a backgrounded app's microphone and, before long, the app;
 * a foreground service of type "microphone" is how a call says it is still
 * in use. Its notification is the call's handle from anywhere: tap to go
 * back to the app, or mute and leave without opening it.
 *
 * The service only holds the call up. The call itself — WebRTC, the socket,
 * the shared VoiceEngine — runs in the app's JavaScript as before.
 */
class CallService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_MUTE, ACTION_LEAVE -> {
        onAction?.invoke(if (intent.action == ACTION_LEAVE) "leave" else "toggleMute")
        return START_NOT_STICKY
      }
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "In a call"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val muted = intent?.getBooleanExtra(EXTRA_MUTED, false) ?: false
    val notification = buildNotification(title, text, muted)
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    } catch (e: Exception) {
      // Refused (no microphone permission yet, or started from the
      // background): the call still runs while the app is open.
      android.util.Log.w(TAG, "could not start the call's foreground service", e)
      stopSelf()
      return START_NOT_STICKY
    }
    holdLocks()
    // A call that died with the process is not one to bring back.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  // The app was swiped away from recents: the JavaScript that ran the call is
  // gone with it, so the notification must not outlive it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    onAction?.invoke("leave")
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun holdLocks() {
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      // Audio keeps flowing with the screen off; the CPU has to stay up for it.
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "chatter:call").apply {
        setReferenceCounted(false)
        acquire(MAX_CALL_MS)
      }
    }
    if (wifiLock == null) {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      // Wi-Fi power saving batches packets, which a call hears as stutter.
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = wifi.createWifiLock(mode, "chatter:call").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
  }

  private fun buildNotification(title: String, text: String, muted: Boolean): Notification {
    ensureChannel(this)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
    }
    val immutable = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val contentIntent = open?.let { PendingIntent.getActivity(this, 0, it, immutable) }
    val mute = PendingIntent.getService(this, 1, Intent(this, CallService::class.java).setAction(ACTION_MUTE), immutable)
    val leave = PendingIntent.getService(this, 2, Intent(this, CallService::class.java).setAction(ACTION_LEAVE), immutable)

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.chatter_call_notification)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setUsesChronometer(true)
      .setWhen(startedAt)
      .addAction(0, if (muted) "Unmute" else "Mute", mute)
      .addAction(0, "Leave", leave)
      .build()
  }

  companion object {
    private const val TAG = "ChatterCall"
    const val CHANNEL_ID = "chatter_calls"
    const val NOTIFICATION_ID = 4107
    const val ACTION_MUTE = "io.zgaf.chatter.call.MUTE"
    const val ACTION_LEAVE = "io.zgaf.chatter.call.LEAVE"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_MUTED = "muted"
    /** Nobody is on a call this long; the lock is not left on forever. */
    private const val MAX_CALL_MS = 12L * 60 * 60 * 1000

    /** When the call began, for the notification's running clock. */
    var startedAt: Long = System.currentTimeMillis()

    /** The module listens here for the notification's buttons. */
    var onAction: ((String) -> Unit)? = null

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while you are in a voice channel"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }
  }
}
