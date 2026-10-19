package io.zgaf.chatter.call

import android.app.Activity
import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer

/**
 * Picture-in-picture for a stream being watched: the app shrinks to a small
 * window over whatever comes next, showing just the picture, and comes back
 * full size when tapped. Android does it for the whole activity, so the app
 * decides what that window shows (the stream alone) when it hears it is in
 * one.
 */
class PictureInPicture(private val onChange: (Boolean) -> Unit) {
  private var watching: ComponentActivity? = null
  private val listener = Consumer<PictureInPictureModeChangedInfo> { info -> onChange(info.isInPictureInPictureMode) }

  /** Follow the activity's picture-in-picture changes. */
  fun attach(activity: Activity?) {
    val component = activity as? ComponentActivity ?: return
    if (component === watching) return
    watching?.removeOnPictureInPictureModeChangedListener(listener)
    component.addOnPictureInPictureModeChangedListener(listener)
    watching = component
  }

  fun detach() {
    watching?.removeOnPictureInPictureModeChangedListener(listener)
    watching = null
  }

  /**
   * While a stream is on screen, leaving the app (home, another app) takes it
   * along in a small window — on Android 12 and later, which do it as the app
   * goes rather than after. Off again once the stream is put away.
   */
  fun setAuto(activity: Activity, enabled: Boolean, width: Int, height: Int) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    activity.runOnUiThread {
      try {
        activity.setPictureInPictureParams(params(enabled, width, height))
      } catch (e: Exception) {
        android.util.Log.w("ChatterCall", "picture-in-picture not available", e)
      }
    }
  }

  /** Into the small window now. False where the phone has none. */
  fun enter(activity: Activity, width: Int, height: Int): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    activity.runOnUiThread {
      try {
        activity.enterPictureInPictureMode(params(true, width, height))
      } catch (e: Exception) {
        android.util.Log.w("ChatterCall", "could not enter picture-in-picture", e)
      }
    }
    return true
  }

  fun isActive(activity: Activity?): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity?.isInPictureInPictureMode == true

  private fun params(auto: Boolean, width: Int, height: Int): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(aspect(width, height))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(true)
    }
    return builder.build()
  }

  /** The stream's shape, within what Android allows a small window to be. */
  private fun aspect(width: Int, height: Int): Rational {
    if (width <= 0 || height <= 0) return Rational(16, 9)
    val ratio = width.toDouble() / height
    return when {
      ratio > 2.39 -> Rational(239, 100)
      ratio < 1 / 2.39 -> Rational(100, 239)
      else -> Rational(width, height)
    }
  }
}
