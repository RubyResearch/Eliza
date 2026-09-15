/**
 * Native Android half of `ElizaSurfaceManager` (#15245): layers one [WebView]
 * per Browser tab above the Capacitor host webview, each with a platform-managed
 * out-of-app renderer and its OWN storage partition. A computed outer clip
 * follows the rounded React host while independent rounded occlusion holes
 * expose host-rendered chrome without resizing or hiding the live page.
 *
 * Isolation maps onto two androidx.webkit primitives. Renderer: the WebView
 * renderer runs out-of-process by platform default on API 26+; Android may
 * reuse that sandboxed process across sibling WebViews, so `isolated` means
 * isolated from the app/host renderer rather than a guaranteed per-tab process.
 * The surface fails fast if even that platform boundary is unavailable.
 * Storage: an `isolated` surface gets its own multi-profile [androidx.webkit
 * Profile][ProfileStore] (cookies/localStorage/IndexedDB partitioned); a
 * `shared` surface uses the default profile. There is NO silent degrade — if the
 * system WebView is too old for multi-profile, `createSurface` rejects, because a
 * surface that quietly shares the default store is the exact leak this closes.
 * Android keeps a loaded profile in use after its WebView is destroyed, so
 * retired profiles are never reused and are purged at the next process start.
 */
package ai.eliza.plugins.browsersurface

import android.content.Context
import android.graphics.Canvas
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Region
import android.os.Build
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

internal data class NativeOwnerIdentity(
    val owner: String,
    val session: String,
    val epoch: Long,
)

internal class ActiveOwnerRegistry {
    private data class Lease(val session: String, val epoch: Long)

    private val leases = HashMap<String, Lease>()

    fun claim(identity: NativeOwnerIdentity): Boolean {
        val current = leases[identity.owner]
        if (
            current != null &&
            (identity.epoch < current.epoch ||
                (identity.epoch == current.epoch && identity.session != current.session))
        ) {
            return false
        }
        if (current == null || identity.epoch > current.epoch) {
            leases[identity.owner] = Lease(identity.session, identity.epoch)
        }
        return true
    }

    fun isActive(identity: NativeOwnerIdentity): Boolean {
        val current = leases[identity.owner] ?: return false
        return current.session == identity.session && current.epoch == identity.epoch
    }
}

internal fun supportsIsolatedRenderer(
    apiLevel: Int,
    rendererFeatureSupported: Boolean,
    rendererHandlePresent: Boolean,
): Boolean =
    apiLevel >= Build.VERSION_CODES.O && rendererFeatureSupported && rendererHandlePresent

internal fun supportsIsolatedStorage(multiProfileFeatureSupported: Boolean): Boolean =
    multiProfileFeatureSupported

@CapacitorPlugin(name = "ElizaSurfaceManager")
class ElizaSurfaceManagerPlugin : Plugin() {
    private companion object {
        const val TAG = "ElizaSurfaceManager"
        const val PROFILE_NAMESPACE_PREFIX = "eliza-browser-"
    }

    private data class HostOuterClip(
        val x: Double,
        val y: Double,
        val width: Double,
        val height: Double,
        val topLeftRadius: Double,
        val topRightRadius: Double,
        val bottomRightRadius: Double,
        val bottomLeftRadius: Double,
    )

    private data class HostOcclusionRect(
        val x: Double,
        val y: Double,
        val width: Double,
        val height: Double,
        val cornerRadius: Double,
    )

    private data class Surface(
        val container: OccludingSurfaceLayout,
        val webView: WebView,
        val process: String,
        val storage: String,
        val owner: String,
        val session: String,
        val epoch: Long,
        val profileName: String?,
        var foregrounded: Boolean,
        var disposed: Boolean = false,
        var pageRevision: Long = 0,
        var pageError: String? = null,
        var x: Double = 0.0,
        var y: Double = 0.0,
        var outerClip: HostOuterClip? = null,
        var occlusions: List<HostOcclusionRect> = emptyList(),
    )

    private val surfaces = HashMap<String, Surface>()
    private val activeOwners = ActiveOwnerRegistry()
    private val retiredProfiles = HashSet<String>()
    private val profileProcessNonce = UUID.randomUUID().toString()
    private var profileSerial = 0L
    private val pageReader by lazy {
        context.assets.open("read-page.js").bufferedReader().use { it.readText() }
    }

    override fun load() {
        super.load()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val store = ProfileStore.getInstance()
        for (name in store.allProfileNames) {
            if (!name.startsWith(PROFILE_NAMESPACE_PREFIX)) continue
            try {
                store.deleteProfile(name)
            } catch (error: RuntimeException) {
                Log.w(TAG, "Could not purge retired Browser profile $name", error)
            }
        }
    }

    private fun density(): Float = activity.resources.displayMetrics.density

    private fun requireIdentity(call: PluginCall, operation: String): NativeOwnerIdentity? {
        val owner = call.getString("owner")
        val session = call.getString("session")
        val epoch = call.getLong("epoch")
        if (owner.isNullOrBlank() || session.isNullOrBlank() || epoch == null || epoch <= 0L) {
            call.reject("$operation requires owner, session, and a positive epoch")
            return null
        }
        return NativeOwnerIdentity(owner, session, epoch)
    }

    private fun requireActiveIdentity(call: PluginCall, operation: String): NativeOwnerIdentity? {
        val identity = requireIdentity(call, operation) ?: return null
        if (!activeOwners.isActive(identity)) {
            call.reject("$operation rejected a retired or unclaimed renderer session")
            return null
        }
        return identity
    }

    private fun ownedSurface(
        call: PluginCall,
        id: String,
        identity: NativeOwnerIdentity,
        operation: String,
    ): Surface? {
        val surface = surfaces[id]
        if (surface == null) {
            call.reject("no surface $id")
            return null
        }
        if (surface.disposed) {
            call.reject("$operation cannot use surface $id while native teardown is incomplete")
            return null
        }
        if (
            surface.owner != identity.owner ||
            surface.session != identity.session ||
            surface.epoch != identity.epoch
        ) {
            call.reject("$operation cannot mutate surface $id owned by another renderer session")
            return null
        }
        return surface
    }

    private fun digest(value: String): String = MessageDigest
        .getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun profileName(owner: String, session: String, epoch: Long, id: String): String {
        profileSerial += 1
        return "$PROFILE_NAMESPACE_PREFIX${digest("$profileProcessNonce\u0000$owner\u0000$session\u0000$epoch\u0000$id\u0000$profileSerial").take(48)}"
    }

    private fun retireProfile(name: String) {
        retiredProfiles.add(name)
    }

    private fun disposeSurface(surface: Surface) {
        if (!surface.disposed) {
            surface.container.visibility = View.GONE
            surface.foregrounded = false
            surface.webView.stopLoading()
            (surface.container.parent as? ViewGroup)?.removeView(surface.container)
            surface.container.removeView(surface.webView)
            surface.webView.destroy()
            surface.disposed = true
        }
        surface.profileName?.let(::retireProfile)
    }

    @PluginMethod
    fun createSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("createSurface requires an id")
            return
        }
        val process = call.getString("process")
        if (process != "isolated" && process != "shared") {
            call.reject("createSurface requires an explicit process policy (isolated|shared)")
            return
        }
        val storage = call.getString("storage")
        if (storage != "isolated" && storage != "shared") {
            call.reject("createSurface requires an explicit storage policy (isolated|shared)")
            return
        }
        val url = call.getString("url")

        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "createSurface") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val existing = surfaces[id]
            if (existing != null) {
                if (existing.disposed) {
                    call.reject("surface $id is awaiting native teardown")
                    return@runOnUiThread
                }
                if (
                    existing.owner != owner || existing.session != session ||
                    existing.epoch != identity.epoch ||
                    existing.process != process || existing.storage != storage
                ) {
                    call.reject("surface $id already exists with different owner/session/policy")
                    return@runOnUiThread
                }
                if (url != null && existing.webView.url != url) existing.webView.loadUrl(url)
                call.resolve()
                return@runOnUiThread
            }
            val host = findNearestFrameLayoutAncestor(bridge.webView) ?: run {
                call.reject("host webview has no FrameLayout ancestor to attach the surface to")
                return@runOnUiThread
            }

            val container = OccludingSurfaceLayout(activity)
            val webView = WebView(activity)
            webView.webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    surfaces.values.firstOrNull { it.webView === view }?.let {
                        it.pageRevision += 1
                        it.pageError = null
                    }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) {
                        surfaces.values.firstOrNull { it.webView === view }?.pageError = error.description.toString()
                    }
                }

                override fun onPageFinished(view: WebView, url: String) {
                    val surface = surfaces[id] ?: return
                    if (surface.webView !== view || surface.disposed || view.url != url) return
                    if (!activeOwners.isActive(NativeOwnerIdentity(surface.owner, surface.session, surface.epoch))) return
                    notifyListeners("navigationChanged", JSObject().apply {
                        put("id", id)
                        put("owner", surface.owner)
                        put("session", surface.session)
                        put("epoch", surface.epoch)
                    })
                }
            }
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true
            webView.settings.databaseEnabled = true
            container.addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )

            // Storage isolation via multi-profile. Fail-fast: no silent degrade
            // to the shared default profile on an unsupported system WebView.
            var profileName: String? = null
            if (storage == "isolated") {
                if (
                    !supportsIsolatedStorage(
                        WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
                    )
                ) {
                    webView.destroy()
                    call.reject("isolated storage requires WebView multi-profile support; system WebView is too old")
                    return@runOnUiThread
                }
                profileName = profileName(owner, session, identity.epoch, id)
                val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
                WebViewCompat.setProfile(webView, profile.name)
            }
            // shared storage ⇒ the default profile (host-scoped store).

            val lp = FrameLayout.LayoutParams(0, 0)
            host.addView(container, lp)
            container.visibility = View.GONE
            if (url != null) webView.loadUrl(url)

            // The renderer handle proves separation from the app process, which
            // is the strongest Android WebView guarantee. Android may reuse the
            // sandboxed renderer between WebViews, so this does not claim a
            // permanent per-tab crash boundary.
            val rendererFeatureSupported =
                WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER)
            val rendererHandlePresent = rendererFeatureSupported &&
                WebViewCompat.getWebViewRenderProcess(webView) != null
            if (
                process == "isolated" &&
                !supportsIsolatedRenderer(
                    Build.VERSION.SDK_INT,
                    rendererFeatureSupported,
                    rendererHandlePresent,
                )
            ) {
                host.removeView(container)
                webView.destroy()
                try {
                    profileName?.let(::retireProfile)
                    call.reject("isolated process policy requires an out-of-app WebView renderer, which is unavailable on this device")
                } catch (error: RuntimeException) {
                    call.reject("isolated renderer creation failed and its profile could not be released", error)
                }
                return@runOnUiThread
            }

            surfaces[id] = Surface(
                container,
                webView,
                process,
                storage,
                owner,
                session,
                identity.epoch,
                profileName,
                false,
            )
            call.resolve()
        }
    }

    @PluginMethod
    fun setBounds(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setBounds requires an id")
            return
        }
        val x = call.getDouble("x")
        val y = call.getDouble("y")
        val width = call.getDouble("width")
        val height = call.getDouble("height")
        val rawOuterClip = call.getObject("outerClip")
        val rawCornerRadii = rawOuterClip?.optJSONObject("cornerRadii")
        if (x == null || y == null || width == null || height == null || rawOuterClip == null || rawCornerRadii == null) {
            call.reject("setBounds requires page bounds and an outerClip with cornerRadii")
            return
        }
        val outerClip = HostOuterClip(
            x = rawOuterClip.optDouble("x", Double.NaN),
            y = rawOuterClip.optDouble("y", Double.NaN),
            width = rawOuterClip.optDouble("width", Double.NaN),
            height = rawOuterClip.optDouble("height", Double.NaN),
            topLeftRadius = rawCornerRadii.optDouble("topLeft", Double.NaN),
            topRightRadius = rawCornerRadii.optDouble("topRight", Double.NaN),
            bottomRightRadius = rawCornerRadii.optDouble("bottomRight", Double.NaN),
            bottomLeftRadius = rawCornerRadii.optDouble("bottomLeft", Double.NaN),
        )
        if (
            !x.isFinite() || !y.isFinite() || !width.isFinite() || !height.isFinite() ||
            width < 0.0 || height < 0.0 || !outerClip.hasValidGeometry()
        ) {
            call.reject("setBounds has invalid page or outer clip geometry")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "setBounds") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setBounds")
                ?: return@runOnUiThread
            val d = density()
            val lp = FrameLayout.LayoutParams((width * d).toInt(), (height * d).toInt())
            lp.leftMargin = (x * d).toInt()
            lp.topMargin = (y * d).toInt()
            surface.x = x
            surface.y = y
            surface.outerClip = outerClip
            val current = surface.container.layoutParams as? FrameLayout.LayoutParams
            if (
                current == null || current.width != lp.width || current.height != lp.height ||
                current.leftMargin != lp.leftMargin || current.topMargin != lp.topMargin
            ) {
                surface.container.layoutParams = lp
            }
            applyGeometry(surface, d)
            call.resolve()
        }
    }

    @PluginMethod
    fun setOcclusionRects(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("setOcclusionRects requires an id")
            return
        }
        val rawRects = call.getArray("rects") ?: run {
            call.reject("setOcclusionRects requires a rects array")
            return
        }
        val rects = ArrayList<HostOcclusionRect>(rawRects.length())
        for (index in 0 until rawRects.length()) {
            val raw = rawRects.optJSONObject(index) ?: run {
                call.reject("setOcclusionRects rect $index must be an object")
                return
            }
            val x = raw.optDouble("x", Double.NaN)
            val y = raw.optDouble("y", Double.NaN)
            val width = raw.optDouble("width", Double.NaN)
            val height = raw.optDouble("height", Double.NaN)
            val cornerRadius = raw.optDouble("cornerRadius", 0.0)
            if (
                !x.isFinite() ||
                !y.isFinite() ||
                !width.isFinite() ||
                !height.isFinite() ||
                !cornerRadius.isFinite() ||
                width < 0.0 ||
                height < 0.0 ||
                cornerRadius < 0.0
            ) {
                call.reject("setOcclusionRects rect $index has invalid geometry")
                return
            }
            rects.add(HostOcclusionRect(x, y, width, height, cornerRadius))
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "setOcclusionRects") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "setOcclusionRects")
                ?: return@runOnUiThread
            surface.occlusions = rects
            applyOcclusions(surface, density())
            call.resolve()
        }
    }

    @PluginMethod
    fun navigate(call: PluginCall) {
        val id = call.getString("id")
        val url = call.getString("url")
        if (id == null || url == null) {
            call.reject("navigate requires an id and a url")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "navigate") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "navigate")
                ?: return@runOnUiThread
            surface.webView.loadUrl(url)
            call.resolve()
        }
    }

    @PluginMethod
    fun reloadSurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("reloadSurface requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "reloadSurface") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "reloadSurface")
                ?: return@runOnUiThread
            surface.webView.reload()
            call.resolve()
        }
    }

    @PluginMethod
    fun goBack(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("goBack requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "goBack") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "goBack") ?: return@runOnUiThread
            if (surface.webView.canGoBack()) surface.webView.goBack()
            call.resolve()
        }
    }

    @PluginMethod
    fun readPage(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("readPage requires an id")
            return
        }
        val selector = call.getString("selector") ?: "body"
        if (selector.isBlank() || selector.length > 2048) {
            call.reject("readPage requires a nonempty selector of at most 2048 characters")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "readPage") ?: return@runOnUiThread
            val surface = ownedSurface(call, id, identity, "readPage") ?: return@runOnUiThread
            if (!surface.foregrounded || surface.webView.progress < 100 || surface.pageError != null) {
                call.reject(surface.pageError ?: "The native page is hidden or still loading")
                return@runOnUiThread
            }
            val revision = surface.pageRevision
            val url = surface.webView.url
            var settled = false
            val timeout = Runnable {
                if (!settled) {
                    settled = true
                    call.reject("Native page read timed out")
                }
            }
            surface.webView.postDelayed(timeout, 5000)
            try {
                surface.webView.evaluateJavascript("($pageReader)(${JSONObject.quote(selector)})") { raw ->
                    if (settled) return@evaluateJavascript
                    settled = true
                    surface.webView.removeCallbacks(timeout)
                    if (!activeOwners.isActive(identity) || surfaces[id] !== surface || surface.disposed ||
                        !surface.foregrounded || surface.pageRevision != revision || surface.webView.url != url) {
                        call.reject("Native page changed while reading; discard this result")
                        return@evaluateJavascript
                    }
                    try {
                        val result = JSObject(raw)
                        if (result.has("error")) call.reject(result.getString("error"))
                        else call.resolve(result)
                    } catch (error: Exception) {
                        call.reject("Native page returned an invalid read result", error)
                    }
                }
            } catch (error: Exception) {
                settled = true
                surface.webView.removeCallbacks(timeout)
                call.reject("Native page read failed", error)
            }
        }
    }

    @PluginMethod
    fun presentSurface(call: PluginCall) {
        val id = call.getString("id")
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "presentSurface") ?: return@runOnUiThread
            val owner = identity.owner
            for (surface in surfaces.values) {
                if (surface.owner == owner) {
                    surface.container.visibility = View.GONE
                    surface.foregrounded = false
                }
            }
            val selected = id?.let {
                ownedSurface(call, it, identity, "presentSurface")
                    ?: return@runOnUiThread
            }
            selected?.let { surface ->
                surface.container.bringToFront()
                surface.container.visibility = View.VISIBLE
                surface.foregrounded = true
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun destroySurface(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("destroySurface requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "destroySurface") ?: return@runOnUiThread
            val surface = surfaces[id]
            if (surface == null) {
                call.resolve()
                return@runOnUiThread
            }
            if (
                surface.owner != identity.owner ||
                surface.session != identity.session ||
                surface.epoch != identity.epoch
            ) {
                call.reject("destroySurface cannot mutate surface $id owned by another renderer session")
                return@runOnUiThread
            }
            try {
                disposeSurface(surface)
                surfaces.remove(id)
                call.resolve()
            } catch (error: RuntimeException) {
                call.reject("destroySurface could not release surface $id", error)
            }
        }
    }

    @PluginMethod
    fun getSurfaceState(call: PluginCall) {
        val id = call.getString("id") ?: run {
            call.reject("getSurfaceState requires an id")
            return
        }
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "getSurfaceState") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val result = JSObject()
            val surface = surfaces[id]
            if (
                surface == null || surface.owner != owner || surface.session != session ||
                surface.epoch != identity.epoch
            ) {
                result.put("exists", false)
                result.put("foregrounded", false)
                result.put("currentUrl", JSObject.NULL)
                result.put("process", JSObject.NULL)
                result.put("storage", JSObject.NULL)
                result.put("owner", JSObject.NULL)
                result.put("session", JSObject.NULL)
                result.put("epoch", JSObject.NULL)
            } else {
                result.put("exists", true)
                result.put("foregrounded", surface.foregrounded)
                result.put("currentUrl", surface.webView.url ?: JSObject.NULL)
                result.put("process", surface.process)
                result.put("storage", surface.storage)
                result.put("owner", surface.owner)
                result.put("session", surface.session)
                result.put("epoch", surface.epoch)
            }
            call.resolve(result)
        }
    }

    @PluginMethod
    fun listSurfaceStates(call: PluginCall) {
        activity.runOnUiThread {
            val identity = requireActiveIdentity(call, "listSurfaceStates") ?: return@runOnUiThread
            val owner = identity.owner
            val session = identity.session
            val surfacesResult = com.getcapacitor.JSArray()
            for ((id, surface) in surfaces) {
                if (
                    surface.owner != owner || surface.session != session ||
                    surface.epoch != identity.epoch
                ) continue
                surfacesResult.put(surfaceState(id, surface))
            }
            val result = JSObject()
            result.put("surfaces", surfacesResult)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun reconcileOwner(call: PluginCall) {
        val identity = requireIdentity(call, "reconcileOwner") ?: return
        val owner = identity.owner
        val session = identity.session
        val desiredArray = call.getArray("desiredIds") ?: run {
            call.reject("reconcileOwner requires desiredIds")
            return
        }
        val desiredIds = HashSet<String>()
        for (index in 0 until desiredArray.length()) {
            val id = desiredArray.optString(index, "")
            if (id.isBlank()) {
                call.reject("reconcileOwner desiredIds must contain strings")
                return
            }
            desiredIds.add(id)
        }
        activity.runOnUiThread {
            if (!activeOwners.claim(identity)) {
                call.reject("reconcileOwner rejected a retired renderer session")
                return@runOnUiThread
            }
            // Presentation is fenced before fallible cleanup so a stale page
            // cannot remain visible or interactive after its realm is retired.
            for (surface in surfaces.values) {
                if (surface.owner == owner) {
                    surface.container.visibility = View.GONE
                    surface.foregrounded = false
                }
            }
            try {
                val staleIds = surfaces.entries
                    .filter { entry ->
                        val surface = entry.value
                        surface.owner == owner &&
                            (surface.session != session ||
                                surface.epoch != identity.epoch ||
                                !desiredIds.contains(entry.key))
                    }
                    .map { it.key }
                for (id in staleIds) {
                    val surface = surfaces.getValue(id)
                    disposeSurface(surface)
                    surfaces.remove(id)
                }
                call.resolve()
            } catch (error: RuntimeException) {
                call.reject("reconcileOwner could not release stale Browser surfaces", error)
            }
        }
    }

    private fun surfaceState(id: String, surface: Surface): JSObject = JSObject().apply {
        put("id", id)
        put("exists", true)
        put("foregrounded", surface.foregrounded)
        put("currentUrl", surface.webView.url ?: JSObject.NULL)
        put("process", surface.process)
        put("storage", surface.storage)
        put("owner", surface.owner)
        put("session", surface.session)
        put("epoch", surface.epoch)
    }

    private fun HostOuterClip.hasValidGeometry(): Boolean =
        x.isFinite() && y.isFinite() && width.isFinite() && height.isFinite() &&
            topLeftRadius.isFinite() && topRightRadius.isFinite() &&
            bottomRightRadius.isFinite() && bottomLeftRadius.isFinite() &&
            width >= 0.0 && height >= 0.0 && topLeftRadius >= 0.0 &&
            topRightRadius >= 0.0 && bottomRightRadius >= 0.0 && bottomLeftRadius >= 0.0

    private fun applyGeometry(surface: Surface, density: Float) {
        surface.container.setOuterClip(
            surface.outerClip?.let { clip ->
                RoundedOuterClip(
                    left = ((clip.x - surface.x) * density).toFloat(),
                    top = ((clip.y - surface.y) * density).toFloat(),
                    right = ((clip.x - surface.x + clip.width) * density).toFloat(),
                    bottom = ((clip.y - surface.y + clip.height) * density).toFloat(),
                    topLeftRadius = (clip.topLeftRadius * density).toFloat(),
                    topRightRadius = (clip.topRightRadius * density).toFloat(),
                    bottomRightRadius = (clip.bottomRightRadius * density).toFloat(),
                    bottomLeftRadius = (clip.bottomLeftRadius * density).toFloat(),
                )
            },
        )
        applyOcclusions(surface, density)
    }

    private fun applyOcclusions(surface: Surface, density: Float) {
        surface.container.setOcclusions(
            surface.occlusions.map { rect ->
                RoundedOcclusionRect(
                    left = ((rect.x - surface.x) * density).toFloat(),
                    top = ((rect.y - surface.y) * density).toFloat(),
                    right = ((rect.x - surface.x + rect.width) * density).toFloat(),
                    bottom = ((rect.y - surface.y + rect.height) * density).toFloat(),
                    cornerRadius = (rect.cornerRadius * density).toFloat(),
                )
            },
        )
    }
}

internal data class RoundedOuterClip(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    val topLeftRadius: Float,
    val topRightRadius: Float,
    val bottomRightRadius: Float,
    val bottomLeftRadius: Float,
) {
    private val normalizedRadii: FloatArray = run {
        val raw = floatArrayOf(
            topLeftRadius.coerceAtLeast(0f),
            topRightRadius.coerceAtLeast(0f),
            bottomRightRadius.coerceAtLeast(0f),
            bottomLeftRadius.coerceAtLeast(0f),
        )
        val width = (right - left).coerceAtLeast(0f)
        val height = (bottom - top).coerceAtLeast(0f)
        fun edgeScale(length: Float, first: Float, second: Float): Float {
            val total = first + second
            return if (total > 0f) length / total else 1f
        }
        val scale = minOf(
            1f,
            edgeScale(width, raw[0], raw[1]),
            edgeScale(width, raw[3], raw[2]),
            edgeScale(height, raw[0], raw[3]),
            edgeScale(height, raw[1], raw[2]),
        )
        FloatArray(raw.size) { index -> raw[index] * scale }
    }

    fun pathRadii(): FloatArray = floatArrayOf(
        normalizedRadii[0],
        normalizedRadii[0],
        normalizedRadii[1],
        normalizedRadii[1],
        normalizedRadii[2],
        normalizedRadii[2],
        normalizedRadii[3],
        normalizedRadii[3],
    )

    fun contains(x: Float, y: Float): Boolean {
        if (x < left || x > right || y < top || y > bottom) return false
        val topLeft = normalizedRadii[0]
        val topRight = normalizedRadii[1]
        val bottomRight = normalizedRadii[2]
        val bottomLeft = normalizedRadii[3]
        val (radius, centerX, centerY) = when {
            x < left + topLeft && y < top + topLeft ->
                Triple(topLeft, left + topLeft, top + topLeft)
            x > right - topRight && y < top + topRight ->
                Triple(topRight, right - topRight, top + topRight)
            x > right - bottomRight && y > bottom - bottomRight ->
                Triple(bottomRight, right - bottomRight, bottom - bottomRight)
            x < left + bottomLeft && y > bottom - bottomLeft ->
                Triple(bottomLeft, left + bottomLeft, bottom - bottomLeft)
            else -> return true
        }
        if (radius <= 0f) return true
        val dx = x - centerX
        val dy = y - centerY
        return dx * dx + dy * dy <= radius * radius
    }
}

internal data class RoundedOcclusionRect(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    val cornerRadius: Float,
) {
    fun contains(x: Float, y: Float): Boolean {
        if (x < left || x > right || y < top || y > bottom) return false
        val radius =
            cornerRadius
                .coerceAtMost((right - left) / 2f)
                .coerceAtMost((bottom - top) / 2f)
        if (
            radius <= 0f ||
            x in (left + radius)..(right - radius) ||
            y in (top + radius)..(bottom - radius)
        ) {
            return true
        }
        val centerX = if (x < left + radius) left + radius else right - radius
        val centerY = if (y < top + radius) top + radius else bottom - radius
        val dx = x - centerX
        val dy = y - centerY
        return dx * dx + dy * dy <= radius * radius
    }
}

/**
 * Clips the native page to its rounded React host, then removes host-rendered
 * chrome while keeping the page full-size and live. Returning false outside
 * that outer clip or inside an occlusion lets the parent continue hit-testing
 * the Capacitor host WebView underneath.
 */
internal class OccludingSurfaceLayout(context: Context) : FrameLayout(context) {
    private var outerClip: RoundedOuterClip? = null
    private var occlusions: List<RoundedOcclusionRect> = emptyList()
    private val clipPath = Path()

    fun setOuterClip(clip: RoundedOuterClip?) {
        if (outerClip == clip) return
        outerClip = clip
        invalidate()
    }

    fun setOcclusions(rects: List<RoundedOcclusionRect>) {
        if (occlusions == rects) return
        occlusions = rects
        invalidate()
    }

    override fun dispatchDraw(canvas: Canvas) {
        if (outerClip == null && occlusions.isEmpty()) {
            super.dispatchDraw(canvas)
            return
        }
        val saveCount = canvas.save()
        outerClip?.let { clip ->
            clipPath.reset()
            clipPath.addRoundRect(
                RectF(clip.left, clip.top, clip.right, clip.bottom),
                clip.pathRadii(),
                Path.Direction.CW,
            )
            canvas.clipPath(clipPath)
        }
        for (rect in occlusions) {
            clipPath.reset()
            clipPath.addRoundRect(
                RectF(rect.left, rect.top, rect.right, rect.bottom),
                rect.cornerRadius,
                rect.cornerRadius,
                Path.Direction.CW,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                canvas.clipOutPath(clipPath)
            } else {
                @Suppress("DEPRECATION")
                canvas.clipPath(clipPath, Region.Op.DIFFERENCE)
            }
        }
        super.dispatchDraw(canvas)
        canvas.restoreToCount(saveCount)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (
            event.actionMasked == MotionEvent.ACTION_DOWN &&
            (outerClip?.contains(event.x, event.y) == false ||
                occlusions.any { it.contains(event.x, event.y) })
        ) {
            return false
        }
        return super.dispatchTouchEvent(event)
    }
}

internal fun findNearestFrameLayoutAncestor(view: View): FrameLayout? {
    var current = view.parent
    while (current is View) {
        if (current is FrameLayout) return current
        current = current.parent
    }
    return null
}
