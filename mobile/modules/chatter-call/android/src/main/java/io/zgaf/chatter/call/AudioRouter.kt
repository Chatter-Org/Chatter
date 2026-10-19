package io.zgaf.chatter.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Where a call's sound comes out.
 *
 * A group voice channel is heard like a speakerphone, not held to the ear, so
 * the default is the loudspeaker — unless a headset is plugged in or paired,
 * which wins as soon as it appears and gives way when it goes. Picking a
 * route by hand sticks until that device disappears.
 *
 * Routes are named by kind ("speaker", "earpiece", "wired", "bluetooth"),
 * which is what a person chooses between; a phone rarely has two of a kind.
 */
class AudioRouter(context: Context, private val onChange: () -> Unit) {
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private var active = false
  private var chosen: String? = null
  private var focus: AudioFocusRequest? = null
  private var previousMode = AudioManager.MODE_NORMAL

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
      // A headset arriving is a choice in itself.
      if (added.any { kindOf(it) == "wired" || kindOf(it) == "bluetooth" }) chosen = null
      apply()
    }

    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
      if (chosen != null && removed.any { kindOf(it) == chosen }) chosen = null
      apply()
    }
  }

  // Android 12 and later settle a change of device on their own time; whoever
  // listens hears about it when it has happened, not just when it was asked.
  private val deviceChanged: Any? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioManager.OnCommunicationDeviceChangedListener { if (active) onChange() }
    } else {
      null
    }

  fun start() {
    if (active) return
    active = true
    previousMode = audio.mode
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    requestFocus()
    audio.registerAudioDeviceCallback(devices, main)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.addOnCommunicationDeviceChangedListener(
        { main.post(it) },
        deviceChanged as AudioManager.OnCommunicationDeviceChangedListener,
      )
    }
    apply()
  }

  fun stop() {
    if (!active) return
    active = false
    chosen = null
    audio.unregisterAudioDeviceCallback(devices)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.removeOnCommunicationDeviceChangedListener(deviceChanged as AudioManager.OnCommunicationDeviceChangedListener)
      audio.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      audio.isSpeakerphoneOn = false
      @Suppress("DEPRECATION")
      if (audio.isBluetoothScoOn) audio.stopBluetoothSco()
    }
    abandonFocus()
    audio.mode = previousMode
  }

  /** Whether the call is coming out of the earpiece: held to the ear. */
  fun onEarpiece(): Boolean = active && current() == "earpiece"

  /** The routes this phone has right now, the one in use marked. */
  fun routes(): List<Map<String, Any>> {
    val current = current()
    return available().map { kind -> mapOf("id" to kind, "label" to LABELS.getValue(kind), "active" to (kind == current)) }
  }

  fun choose(kind: String) {
    if (kind !in available()) return
    chosen = kind
    apply()
  }

  private fun available(): List<String> {
    val kinds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.availableCommunicationDevices.mapNotNull { kindOf(it) }
    } else {
      audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { kindOf(it) }
    }
    return ORDER.filter { it in kinds }
  }

  private fun current(): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return audio.communicationDevice?.let { kindOf(it) }
    @Suppress("DEPRECATION")
    return when {
      audio.isBluetoothScoOn -> "bluetooth"
      audio.isSpeakerphoneOn -> "speaker"
      audio.isWiredHeadsetOn -> "wired"
      else -> "earpiece"
    }
  }

  /** What the call should use: the person's choice, else a headset, else the speaker. */
  private fun target(): String? {
    val kinds = available()
    chosen?.let { if (it in kinds) return it }
    return listOf("bluetooth", "wired", "speaker", "earpiece").firstOrNull { it in kinds }
  }

  private fun apply() {
    if (!active) return
    val kind = target() ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device = audio.availableCommunicationDevices.firstOrNull { kindOf(it) == kind }
      if (device != null && audio.communicationDevice?.id != device.id) audio.setCommunicationDevice(device)
    } else {
      @Suppress("DEPRECATION")
      run {
        if (kind == "bluetooth") {
          audio.isSpeakerphoneOn = false
          audio.startBluetoothSco()
          audio.isBluetoothScoOn = true
        } else {
          if (audio.isBluetoothScoOn) {
            audio.isBluetoothScoOn = false
            audio.stopBluetoothSco()
          }
          audio.isSpeakerphoneOn = kind == "speaker"
        }
      }
    }
    onChange()
  }

  private fun requestFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener { }
        .build()
      focus = request
      audio.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audio.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
    }
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focus?.let { audio.abandonAudioFocusRequest(it) }
      focus = null
    } else {
      @Suppress("DEPRECATION")
      audio.abandonAudioFocus(null)
    }
  }

  companion object {
    private val ORDER = listOf("speaker", "earpiece", "wired", "bluetooth")
    private val LABELS = mapOf(
      "speaker" to "Speaker",
      "earpiece" to "Phone",
      "wired" to "Headphones",
      "bluetooth" to "Bluetooth",
    )

    fun kindOf(device: AudioDeviceInfo): String? = when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
      else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && device.type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }
  }
}
