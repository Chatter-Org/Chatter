package io.zgaf.chatter.call

import android.content.Context
import android.os.PowerManager

/**
 * The screen goes dark against an ear: Android's proximity wake lock, held
 * while a call comes out of the earpiece — the one time the phone is held to
 * the head — so a cheek does not mute the call or leave it. On the speaker or
 * a headset the screen stays as it is.
 */
class ProximityLock(context: Context) {
  private val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
  private var lock: PowerManager.WakeLock? = null

  fun hold(onEar: Boolean) {
    if (onEar) acquire() else release()
  }

  private fun acquire() {
    if (lock?.isHeld == true) return
    if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
    lock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "chatter:proximity").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  fun release() {
    // Taken from the ear mid-call, the screen comes back once nothing is near.
    lock?.let { if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
    lock = null
  }
}
