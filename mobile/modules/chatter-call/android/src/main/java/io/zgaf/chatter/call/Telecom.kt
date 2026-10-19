package io.zgaf.chatter.call

import android.content.ComponentName
import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * The call, as Android's phone system sees it: a self-managed connection.
 *
 * Without one, a phone call arriving mid-call simply talks over it, and a car
 * or a watch knows nothing of it. With one, Android holds the Chatter call
 * while the phone call is answered (Chatter mutes and goes deaf, and comes
 * back as it was), and the car's or watch's hang-up leaves it.
 *
 * Self-managed means Chatter keeps its own call screen and its own audio
 * routing (AudioRouter); this is only the call's place in Telecom. Anything
 * here failing leaves the call exactly as it was without it.
 */
object Telecom {
  private const val TAG = "ChatterCall"
  private const val ACCOUNT_ID = "chatter-calls"

  /** Hold, resume and leave, from Telecom; the module forwards them to JavaScript. */
  var onAction: ((String) -> Unit)? = null

  internal var connection: ChatterConnection? = null

  private fun handle(context: Context) =
    PhoneAccountHandle(ComponentName(context, ChatterConnectionService::class.java), ACCOUNT_ID)

  /** Put the call in Telecom (the call has started). */
  fun start(context: Context, title: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || connection != null) return
    try {
      val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
      val account = PhoneAccount.builder(handle(context), "Chatter")
        .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
        .build()
      telecom.registerPhoneAccount(account)
      val extras = Bundle().apply {
        putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle(context))
        putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply { putString(EXTRA_TITLE, title) })
      }
      telecom.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, title, null), extras)
    } catch (e: Exception) {
      Log.w(TAG, "the call is not in Telecom; a phone call will not hold it", e)
    }
  }

  /** The call has ended here: take it out of Telecom. */
  fun stop() {
    val c = connection ?: return
    c.forget()
    connection = null
    c.setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    c.destroy()
  }

  /** The call's name changed (another channel). */
  fun rename(title: String) {
    connection?.setAddress(Uri.fromParts(PhoneAccount.SCHEME_SIP, title, null), TelecomManager.PRESENTATION_ALLOWED)
  }

  const val EXTRA_TITLE = "io.zgaf.chatter.call.TITLE"
}

/** The Chatter call's connection: Telecom tells it to hold, resume or end. */
class ChatterConnection(private val context: Context) : Connection() {
  private val main = Handler(Looper.getMainLooper())
  private var quietChecks = 0

  /**
   * Telecom does not give a self-managed call its turn back when the phone
   * call that held it ends; nothing is told at all. The audio mode is: it is
   * IN_CALL (or ringing) while a phone call is on, and leaves it when the
   * call is over. Checked once a second while held, and two quiet checks in
   * a row resume the call.
   */
  private val watchForTheEnd = object : Runnable {
    override fun run() {
      if (state != STATE_HOLDING) return
      val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val phoneCallOn = audio.mode == AudioManager.MODE_IN_CALL || audio.mode == AudioManager.MODE_RINGTONE
      quietChecks = if (phoneCallOn) 0 else quietChecks + 1
      if (quietChecks >= 2) resume() else main.postDelayed(this, 1000)
    }
  }

  init {
    connectionProperties = PROPERTY_SELF_MANAGED
    connectionCapabilities = CAPABILITY_HOLD or CAPABILITY_SUPPORT_HOLD or CAPABILITY_MUTE
    audioModeIsVoip = true
  }

  override fun onHold() {
    setOnHold()
    Telecom.onAction?.invoke("hold")
    quietChecks = 0
    main.removeCallbacks(watchForTheEnd)
    main.postDelayed(watchForTheEnd, 1000)
  }

  override fun onUnhold() = resume()

  /** Back from hold: the phone call that held it is over (or was refused). */
  fun resume() {
    main.removeCallbacks(watchForTheEnd)
    if (state != STATE_HOLDING) return
    setActive()
    Telecom.onAction?.invoke("resume")
  }

  /** Ended from this side: stop watching. */
  fun forget() = main.removeCallbacks(watchForTheEnd)

  override fun onDisconnect() = end()

  override fun onAbort() = end()

  private fun end() {
    main.removeCallbacks(watchForTheEnd)
    if (Telecom.connection === this) Telecom.connection = null
    setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
    destroy()
    Telecom.onAction?.invoke("leave")
  }
}

/** Where Telecom asks for the connection once the call is placed. */
class ChatterConnectionService : ConnectionService() {
  override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
    val connection = ChatterConnection(applicationContext)
    val title = request?.extras?.getString(Telecom.EXTRA_TITLE)
    if (title != null) connection.setCallerDisplayName(title, TelecomManager.PRESENTATION_ALLOWED)
    connection.setAddress(request?.address, TelecomManager.PRESENTATION_ALLOWED)
    connection.setActive()
    Telecom.connection = connection
    return connection
  }

  /**
   * Telecom never takes a self-managed call off hold by itself: once the
   * phone call that held it ends, focus comes back here, and the call takes
   * itself back.
   */
  override fun onConnectionServiceFocusGained() {
    Telecom.connection?.resume()
  }

  override fun onConnectionServiceFocusLost() {
    // Another call has the phone: Telecom holds this one (onHold) as it goes.
    connectionServiceFocusReleased()
  }

  override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
    // Telecom refused it (another call in progress that cannot be held, say):
    // the Chatter call goes on as it did before there was a Telecom side.
    Log.w("ChatterCall", "Telecom would not take the call")
  }
}
