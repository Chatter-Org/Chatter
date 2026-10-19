package io.zgaf.chatter.share

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * What another app shared into Chatter (Android's share sheet: ACTION_SEND and
 * ACTION_SEND_MULTIPLE), for JavaScript.
 *
 * A share arrives as the intent that started the app or as a new one while it
 * runs. Either way JavaScript hears "onShare" (or finds one waiting at start)
 * and takes it with `takeShareAsync`, which copies each shared stream into the
 * cache under its own name: the sending app's permission to read it lasts only
 * as long as this activity, and an upload may still be going after that. A
 * share is taken once; the intent is marked so a rotation does not bring it
 * back.
 */
class ChatterShareModule : Module() {
  private var pending: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("ChatterShare")

    Events("onShare")

    OnNewIntent { intent ->
      if (isShare(intent)) {
        pending = intent
        sendEvent("onShare", mapOf<String, Any>())
      }
    }

    /** Whether a share is waiting: the one that started the app, or a later one. */
    Function("hasShare") {
      pending != null || launchShare() != null
    }

    AsyncFunction("takeShareAsync") {
      val intent = pending ?: launchShare() ?: return@AsyncFunction null
      pending = null
      intent.putExtra(TAKEN, true)
      read(intent)
    }
  }

  private fun launchShare(): Intent? {
    val intent = appContext.currentActivity?.intent ?: return null
    return if (isShare(intent) && !intent.getBooleanExtra(TAKEN, false)) intent else null
  }

  private fun isShare(intent: Intent?) =
    intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

  private fun read(intent: Intent): Map<String, Any?> {
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    val uris: List<Uri> = when (intent.action) {
      Intent.ACTION_SEND_MULTIPLE -> streams(intent)
      else -> listOfNotNull(stream(intent))
    }
    val files = uris.mapNotNull { copy(it, intent.type) }
    // What could not be read (the sending app gave no access, or it is gone)
    // is counted, so the person hears about it rather than losing it quietly.
    return mapOf("text" to text, "subject" to subject, "files" to files, "failed" to uris.size - files.size)
  }

  @Suppress("DEPRECATION")
  private fun stream(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

  /** The stream as a file of our own in the cache, with its name, type and size. */
  private fun copy(uri: Uri, intentType: String?): Map<String, Any?>? {
    val context = appContext.reactContext ?: return null
    val resolver = context.contentResolver
    return try {
      var name: String? = null
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) name = c.getString(0)
      }
      val type = resolver.getType(uri) ?: intentType?.takeUnless { it.endsWith("/*") }
      val ext = type?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
      val safeName = (name ?: uri.lastPathSegment ?: "shared")
        .replace(Regex("[\\/:*?\"<>|]"), "_")
        .let { if (ext != null && !it.contains('.')) "$it.$ext" else it }
      val input = resolver.openInputStream(uri) ?: return null
      val dir = File(context.cacheDir, "shared-in/${System.nanoTime()}").apply { mkdirs() }
      val out = File(dir, safeName)
      input.use { from -> out.outputStream().use { from.copyTo(it) } }
      mapOf("uri" to Uri.fromFile(out).toString(), "name" to safeName, "type" to type, "size" to out.length())
    } catch (e: Exception) {
      null
    }
  }

  companion object {
    private const val TAKEN = "io.zgaf.chatter.share.TAKEN"
  }
}
