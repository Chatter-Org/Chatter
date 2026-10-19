package io.zgaf.chatter.fold

import android.app.Activity
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * The window's folds, for JavaScript: where a foldable's hinge runs across the
 * app's window (in dp, relative to the window), whether it is flat or half
 * open, and whether it splits the window in two. Nothing on a phone without
 * one, or with the app on one screen of a closed fold.
 */
class ChatterFoldModule : Module() {
  private var job: Job? = null
  private var watching: Activity? = null
  private var last: List<Map<String, Any>> = emptyList()

  override fun definition() = ModuleDefinition {
    Name("ChatterFold")

    Events("onFoldsChanged")

    // Also where watching starts: the module is made after the activity is
    // already in front, so the foreground event alone would miss the first.
    Function("getFolds") {
      appContext.mainQueue.launch { watch() }
      last
    }

    OnCreate { appContext.mainQueue.launch { watch() } }

    OnActivityEntersForeground { watch() }

    OnActivityDestroys {
      job?.cancel()
      job = null
      watching = null
    }

    OnDestroy {
      job?.cancel()
      job = null
    }
  }

  private fun watch() {
    val activity = appContext.currentActivity ?: return
    if (activity === watching && job?.isActive == true) return
    job?.cancel()
    watching = activity
    job = appContext.mainQueue.launch {
      WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collectLatest { info ->
        last = describe(info, activity.resources.displayMetrics.density)
        sendEvent("onFoldsChanged", mapOf("folds" to last))
      }
    }
  }

  private fun describe(info: WindowLayoutInfo, density: Float): List<Map<String, Any>> =
    info.displayFeatures.filterIsInstance<FoldingFeature>().map { fold ->
      val b = fold.bounds
      mapOf(
        "x" to b.left / density,
        "y" to b.top / density,
        "width" to b.width() / density,
        "height" to b.height() / density,
        "state" to if (fold.state == FoldingFeature.State.HALF_OPENED) "halfOpened" else "flat",
        "orientation" to if (fold.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal",
        "separating" to fold.isSeparating,
        "occluding" to (fold.occlusionType == FoldingFeature.OcclusionType.FULL),
      )
    }
}
