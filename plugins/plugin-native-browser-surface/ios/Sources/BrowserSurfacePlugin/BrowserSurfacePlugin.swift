/**
 * Native iOS half of `ElizaSurfaceManager` (#15245): layers one `WKWebView` per
 * Browser tab above the Capacitor host webview, each with its own WKProcessPool
 * and storage partition. A computed outer clip follows the rounded React host
 * while independent rounded occlusion holes expose host-rendered chrome without
 * resizing or hiding the live page.
 *
 * An `isolated` process gets a fresh `WKProcessPool`; isolated storage gets a
 * non-persistent `WKWebsiteDataStore`. `shared` reuses a plugin-owned pool and
 * the default store, never an implicit policy.
 */
import Foundation
import Capacitor
import WebKit
import UIKit

@objc(ElizaSurfaceManagerPlugin)
public class ElizaSurfaceManagerPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate {
    public let identifier = "ElizaSurfaceManagerPlugin"
    public let jsName = "ElizaSurfaceManager"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOcclusionRects", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroySurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSurfaceState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSurfaceStates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reconcileOwner", returnType: CAPPluginReturnPromise),
    ]

    private struct ActiveOwnerLease {
        let session: String
        let epoch: Int
    }

    private struct Surface {
        let container: OccludingSurfaceView
        let webView: WKWebView
        let process: String
        let storage: String
        let owner: String
        let session: String
        let epoch: Int
        var pageRevision = 0
        var pageError: String? = nil
    }

    private var surfaces: [String: Surface] = [:]
    private var activeOwners: [String: ActiveOwnerLease] = [:]
    // One plugin-owned pool for every `shared`-process surface — deliberate, so a
    // shared surface still never lands in the host's implicit default pool.
    private let sharedProcessPool = WKProcessPool()
    private lazy var pageReader: String? = {
        for host in [Bundle(for: ElizaSurfaceManagerPlugin.self), Bundle.main] {
            if let bundleUrl = host.url(forResource: "ElizaBrowserSurface", withExtension: "bundle"),
               let bundle = Bundle(url: bundleUrl),
               let url = bundle.url(forResource: "read-page", withExtension: "js"),
               let script = try? String(contentsOf: url, encoding: .utf8) { return script }
        }
        return nil
    }()

    private func identity(
        _ call: CAPPluginCall,
        operation: String
    ) -> NativeBrowserOwnerIdentity? {
        guard let owner = call.getString("owner"), !owner.isEmpty,
              let session = call.getString("session"), !session.isEmpty,
              let epoch = call.getInt("epoch"), epoch > 0 else {
            call.reject("\(operation) requires owner, session, and a positive epoch")
            return nil
        }
        return NativeBrowserOwnerIdentity(owner: owner, session: session, epoch: epoch)
    }

    private func claimOwner(_ identity: NativeBrowserOwnerIdentity) -> Bool {
        if let current = activeOwners[identity.owner] {
            if identity.epoch < current.epoch ||
                (identity.epoch == current.epoch && identity.session != current.session) {
                return false
            }
            if identity.epoch == current.epoch {
                return true
            }
        }
        if activeOwners[identity.owner]?.epoch != identity.epoch {
            activeOwners[identity.owner] = ActiveOwnerLease(
                session: identity.session,
                epoch: identity.epoch
            )
        }
        return true
    }

    private func requireActiveIdentity(
        _ call: CAPPluginCall,
        identity: NativeBrowserOwnerIdentity,
        operation: String
    ) -> Bool {
        guard let current = activeOwners[identity.owner],
              current.session == identity.session,
              current.epoch == identity.epoch else {
            call.reject("\(operation) rejected a retired or unclaimed renderer session")
            return false
        }
        return true
    }

    private func ownedSurface(
        _ call: CAPPluginCall,
        id: String,
        identity: NativeBrowserOwnerIdentity,
        operation: String
    ) -> Surface? {
        guard let surface = surfaces[id] else {
            call.reject("no surface \(id)")
            return nil
        }
        guard NativeBrowserSurfaceLifecycleContract.owns(
            owner: surface.owner,
            session: surface.session,
            epoch: surface.epoch,
            identity: identity
        ) else {
            call.reject("\(operation) cannot mutate surface \(id) owned by another renderer session")
            return nil
        }
        return surface
    }

    private func dispose(_ surface: Surface) {
        surface.container.isHidden = true
        surface.webView.stopLoading()
        surface.webView.navigationDelegate = nil
        surface.webView.uiDelegate = nil
        surface.container.removeFromSuperview()
    }

    @objc func createSurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("createSurface requires an id")
            return
        }
        // Explicit-policy invariant: both axes must be stated. No default.
        guard let process = call.getString("process"),
              process == "isolated" || process == "shared" else {
            call.reject("createSurface requires an explicit process policy (isolated|shared)")
            return
        }
        guard let storage = call.getString("storage"),
              storage == "isolated" || storage == "shared" else {
            call.reject("createSurface requires an explicit storage policy (isolated|shared)")
            return
        }
        guard let identity = identity(call, operation: "createSurface") else { return }
        let urlString = call.getString("url")

        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "createSurface"
            ) else { return }
            guard let hostView = self.bridge?.viewController?.view else {
                call.reject("no host view controller to attach the surface to")
                return
            }
            if let existing = self.surfaces[id] {
                guard existing.owner == identity.owner,
                      existing.session == identity.session,
                      existing.epoch == identity.epoch,
                      existing.process == process,
                      existing.storage == storage else {
                    call.reject("surface \(id) already exists with different owner/session/policy")
                    return
                }
                if let urlString, let url = URL(string: urlString),
                   existing.webView.url?.absoluteString != url.absoluteString {
                    existing.webView.load(URLRequest(url: url))
                }
                call.resolve()
                return
            }

            let config = WKWebViewConfiguration()
            // Fresh pool ⇒ a dedicated process-pool boundary; shared ⇒ the plugin pool.
            config.processPool = process == "isolated" ? WKProcessPool() : self.sharedProcessPool
            // Non-persistent store ⇒ private, per-surface cookies/localStorage.
            config.websiteDataStore = storage == "isolated"
                ? WKWebsiteDataStore.nonPersistent()
                : WKWebsiteDataStore.default()

            let container = OccludingSurfaceView(frame: .zero)
            container.isHidden = true
            let webView = WKWebView(frame: container.bounds, configuration: config)
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.installContentView(webView)
            hostView.addSubview(container)
            webView.navigationDelegate = self

            if let urlString = urlString, let url = URL(string: urlString) {
                webView.load(URLRequest(url: url))
            }
            self.surfaces[id] = Surface(
                container: container,
                webView: webView,
                process: process,
                storage: storage,
                owner: identity.owner,
                session: identity.session,
                epoch: identity.epoch
            )
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("setBounds requires an id")
            return
        }
        guard let identity = identity(call, operation: "setBounds") else { return }
        guard let x = call.getDouble("x"), let y = call.getDouble("y"),
              let width = call.getDouble("width"), let height = call.getDouble("height"),
              let rawOuterClip = call.getObject("outerClip"),
              let rawCornerRadii = rawOuterClip["cornerRadii"] as? [String: Any],
              let clipX = (rawOuterClip["x"] as? NSNumber)?.doubleValue,
              let clipY = (rawOuterClip["y"] as? NSNumber)?.doubleValue,
              let clipWidth = (rawOuterClip["width"] as? NSNumber)?.doubleValue,
              let clipHeight = (rawOuterClip["height"] as? NSNumber)?.doubleValue,
              let topLeft = (rawCornerRadii["topLeft"] as? NSNumber)?.doubleValue,
              let topRight = (rawCornerRadii["topRight"] as? NSNumber)?.doubleValue,
              let bottomRight = (rawCornerRadii["bottomRight"] as? NSNumber)?.doubleValue,
              let bottomLeft = (rawCornerRadii["bottomLeft"] as? NSNumber)?.doubleValue else {
            call.reject("setBounds requires page bounds and an outerClip with cornerRadii")
            return
        }
        let outerClip = HostOuterClip(
            x: clipX,
            y: clipY,
            width: clipWidth,
            height: clipHeight,
            topLeftRadius: topLeft,
            topRightRadius: topRight,
            bottomRightRadius: bottomRight,
            bottomLeftRadius: bottomLeft
        )
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width >= 0, height >= 0, outerClip.hasValidGeometry else {
            call.reject("setBounds has invalid page or outer clip geometry")
            return
        }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "setBounds"
            ) else { return }
            guard let surface = self.ownedSurface(
                call,
                id: id,
                identity: identity,
                operation: "setBounds"
            ) else { return }
            // CSS px map 1:1 to UIKit points, so no density conversion is needed.
            let frame = CGRect(x: x, y: y, width: width, height: height)
            if surface.container.frame != frame {
                surface.container.frame = frame
            }
            surface.container.setSurfaceGeometry(
                origin: CGPoint(x: x, y: y),
                outerClip: outerClip
            )
            call.resolve()
        }
    }

    @objc func setOcclusionRects(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("setOcclusionRects requires an id")
            return
        }
        guard let identity = identity(call, operation: "setOcclusionRects") else { return }
        guard let rawRects = call.getArray("rects") as? [[String: Any]] else {
            call.reject("setOcclusionRects requires a rects array")
            return
        }
        var rects: [HostOcclusionRect] = []
        rects.reserveCapacity(rawRects.count)
        for (index, raw) in rawRects.enumerated() {
            guard let x = (raw["x"] as? NSNumber)?.doubleValue,
                  let y = (raw["y"] as? NSNumber)?.doubleValue,
                  let width = (raw["width"] as? NSNumber)?.doubleValue,
                  let height = (raw["height"] as? NSNumber)?.doubleValue else {
                call.reject("setOcclusionRects rect \(index) has invalid geometry")
                return
            }
            let cornerRadius = (raw["cornerRadius"] as? NSNumber)?.doubleValue ?? 0
            guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                  cornerRadius.isFinite, width >= 0, height >= 0, cornerRadius >= 0 else {
                call.reject("setOcclusionRects rect \(index) has invalid geometry")
                return
            }
            rects.append(
                HostOcclusionRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    cornerRadius: cornerRadius
                )
            )
        }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "setOcclusionRects"
            ) else { return }
            guard let surface = self.ownedSurface(
                call,
                id: id,
                identity: identity,
                operation: "setOcclusionRects"
            ) else { return }
            surface.container.setHostOcclusions(rects)
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let urlString = call.getString("url"),
              let url = URL(string: urlString) else {
            call.reject("navigate requires an id and a valid url")
            return
        }
        guard let identity = identity(call, operation: "navigate") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "navigate"
            ) else { return }
            guard let surface = self.ownedSurface(
                call,
                id: id,
                identity: identity,
                operation: "navigate"
            ) else { return }
            surface.webView.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func reloadSurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("reloadSurface requires an id")
            return
        }
        guard let identity = identity(call, operation: "reloadSurface") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "reloadSurface"
            ) else { return }
            guard let surface = self.ownedSurface(
                call,
                id: id,
                identity: identity,
                operation: "reloadSurface"
            ) else { return }
            surface.webView.reload()
            call.resolve()
        }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("goBack requires an id")
            return
        }
        guard let identity = identity(call, operation: "goBack") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(call, identity: identity, operation: "goBack"),
                  let surface = self.ownedSurface(call, id: id, identity: identity, operation: "goBack") else { return }
            if surface.webView.canGoBack { surface.webView.goBack() }
            call.resolve()
        }
    }

    @objc func readPage(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("readPage requires an id")
            return
        }
        guard let identity = identity(call, operation: "readPage") else { return }
        let selector = call.getString("selector") ?? "body"
        guard !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              selector.utf16.count <= 2048 else {
            call.reject("readPage requires a nonempty selector of at most 2048 characters")
            return
        }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(call, identity: identity, operation: "readPage"),
                  let surface = self.ownedSurface(call, id: id, identity: identity, operation: "readPage") else { return }
            guard !surface.container.isHidden, !surface.webView.isLoading, surface.pageError == nil else {
                call.reject(surface.pageError ?? "The native page is hidden or still loading")
                return
            }
            guard let script = self.pageReader,
                  let encoded = try? JSONSerialization.data(withJSONObject: [selector]),
                  let argument = String(data: encoded, encoding: .utf8) else {
                call.reject("The bundled native page reader is unavailable")
                return
            }
            let revision = surface.pageRevision
            let url = surface.webView.url
            var settled = false
            let timeout = DispatchWorkItem {
                if !settled { settled = true; call.reject("Native page read timed out") }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
            surface.webView.evaluateJavaScript("(\(script))(...\(argument))") { value, error in
                if settled { return }
                settled = true
                timeout.cancel()
                guard let active = self.activeOwners[identity.owner],
                      active.session == identity.session, active.epoch == identity.epoch,
                      let current = self.surfaces[id], current.webView === surface.webView,
                      !current.container.isHidden, current.pageRevision == revision, current.webView.url == url else {
                    call.reject("Native page changed while reading; discard this result")
                    return
                }
                if let error { call.reject("Native page read failed", nil, error); return }
                guard let result = value as? [String: Any] else {
                    call.reject("Native page returned an invalid read result")
                    return
                }
                if let error = result["error"] as? String { call.reject(error) }
                else { call.resolve(result) }
            }
        }
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard let id = surfaces.first(where: { $0.value.webView === webView })?.key else { return }
        surfaces[id]?.pageRevision += 1
        surfaces[id]?.pageError = nil
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let id = surfaces.first(where: { $0.value.webView === webView })?.key else { return }
        surfaces[id]?.pageError = error.localizedDescription
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let id = surfaces.first(where: { $0.value.webView === webView })?.key else { return }
        surfaces[id]?.pageError = error.localizedDescription
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let (id, surface) = surfaces.first(where: { $0.value.webView === webView }),
              let active = activeOwners[surface.owner],
              active.session == surface.session, active.epoch == surface.epoch else { return }
        notifyListeners("navigationChanged", data: [
            "id": id, "owner": surface.owner, "session": surface.session, "epoch": surface.epoch,
        ])
    }

    @objc func presentSurface(_ call: CAPPluginCall) {
        guard let identity = identity(call, operation: "presentSurface") else { return }
        let id = call.getString("id")
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "presentSurface"
            ) else { return }
            for surface in self.surfaces.values
            where surface.owner == identity.owner {
                surface.container.isHidden = true
            }
            let selected: Surface?
            if let id {
                guard let surface = self.ownedSurface(
                    call,
                    id: id,
                    identity: identity,
                    operation: "presentSurface"
                ) else { return }
                selected = surface
            } else {
                selected = nil
            }
            if let selected {
                selected.container.superview?.bringSubviewToFront(selected.container)
                selected.container.isHidden = false
            }
            call.resolve()
        }
    }

    @objc func destroySurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("destroySurface requires an id")
            return
        }
        guard let identity = identity(call, operation: "destroySurface") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "destroySurface"
            ) else { return }
            guard let surface = self.surfaces[id] else {
                call.resolve()
                return
            }
            guard surface.owner == identity.owner,
                  surface.session == identity.session,
                  surface.epoch == identity.epoch else {
                call.reject("destroySurface cannot mutate surface \(id) owned by another renderer session")
                return
            }
            self.dispose(surface)
            self.surfaces.removeValue(forKey: id)
            call.resolve()
        }
    }

    @objc func getSurfaceState(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("getSurfaceState requires an id")
            return
        }
        guard let identity = identity(call, operation: "getSurfaceState") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "getSurfaceState"
            ) else { return }
            guard let surface = self.surfaces[id],
                  NativeBrowserSurfaceLifecycleContract.owns(
                      owner: surface.owner,
                      session: surface.session,
                      epoch: surface.epoch,
                      identity: identity
                  ) else {
                call.resolve([
                    "exists": false,
                    "foregrounded": false,
                    "currentUrl": NSNull(),
                    "process": NSNull(),
                    "storage": NSNull(),
                    "owner": NSNull(),
                    "session": NSNull(),
                    "epoch": NSNull(),
                ])
                return
            }
            call.resolve([
                "exists": true,
                "foregrounded": !surface.container.isHidden,
                "currentUrl": surface.webView.url?.absoluteString ?? NSNull(),
                "process": surface.process,
                "storage": surface.storage,
                "owner": surface.owner,
                "session": surface.session,
                "epoch": surface.epoch,
            ])
        }
    }

    @objc func listSurfaceStates(_ call: CAPPluginCall) {
        guard let identity = identity(call, operation: "listSurfaceStates") else { return }
        DispatchQueue.main.async {
            guard self.requireActiveIdentity(
                call,
                identity: identity,
                operation: "listSurfaceStates"
            ) else { return }
            let states = self.surfaces.compactMap { id, surface -> [String: Any]? in
                guard NativeBrowserSurfaceLifecycleContract.owns(
                    owner: surface.owner,
                    session: surface.session,
                    epoch: surface.epoch,
                    identity: identity
                ) else { return nil }
                return self.surfaceState(id: id, surface: surface)
            }
            call.resolve(["surfaces": states])
        }
    }

    @objc func reconcileOwner(_ call: CAPPluginCall) {
        guard let identity = identity(call, operation: "reconcileOwner") else { return }
        guard let desiredIds = call.getArray("desiredIds") as? [String] else {
            call.reject("reconcileOwner requires desiredIds")
            return
        }
        let desired = Set(desiredIds)
        DispatchQueue.main.async {
            guard self.claimOwner(identity) else {
                call.reject("reconcileOwner rejected a retired renderer session")
                return
            }
            // Presentation is fenced before fallible cleanup so a stale page
            // cannot remain visible or interactive after its realm is retired.
            for surface in self.surfaces.values where surface.owner == identity.owner {
                surface.container.isHidden = true
            }
            let staleIds = self.surfaces.compactMap { id, surface -> String? in
                guard surface.owner == identity.owner else { return nil }
                return surface.session != identity.session ||
                    surface.epoch != identity.epoch ||
                    !desired.contains(id) ? id : nil
            }
            for id in staleIds {
                guard let surface = self.surfaces.removeValue(forKey: id) else { continue }
                self.dispose(surface)
            }
            call.resolve()
        }
    }

    private func surfaceState(id: String, surface: Surface) -> [String: Any] {
        [
            "id": id,
            "exists": true,
            "foregrounded": !surface.container.isHidden,
            "currentUrl": surface.webView.url?.absoluteString ?? NSNull(),
            "process": surface.process,
            "storage": surface.storage,
            "owner": surface.owner,
            "session": surface.session,
            "epoch": surface.epoch,
        ]
    }
}

private struct HostOuterClip: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let topLeftRadius: Double
    let topRightRadius: Double
    let bottomRightRadius: Double
    let bottomLeftRadius: Double

    var hasValidGeometry: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite &&
            topLeftRadius.isFinite && topRightRadius.isFinite &&
            bottomRightRadius.isFinite && bottomLeftRadius.isFinite &&
            width >= 0 && height >= 0 && topLeftRadius >= 0 &&
            topRightRadius >= 0 && bottomRightRadius >= 0 && bottomLeftRadius >= 0
    }
}

private struct HostOcclusionRect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let cornerRadius: Double
}

/// Clips native page pixels to the rounded React host, then subtracts overlay
/// holes so UIKit can continue hit-testing the Capacitor host in either region.
private final class OccludingSurfaceView: UIView {
    private var hostOcclusions: [HostOcclusionRect] = []
    private var hostOuterClip: HostOuterClip?
    private var surfaceOrigin: CGPoint = .zero
    private var maskContainers: [OcclusionMaskContainerView] = []
    private var contentView: UIView?
    private let outerClipMask = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        outerClipMask.fillColor = UIColor.white.cgColor
        outerClipMask.frame = bounds
        outerClipMask.path = UIBezierPath(rect: bounds).cgPath
        layer.mask = outerClipMask
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func installContentView(_ view: UIView) {
        guard contentView !== view else { return }
        contentView?.removeFromSuperview()
        contentView = view
        rebuildMaskHierarchy()
    }

    func setSurfaceGeometry(origin: CGPoint, outerClip: HostOuterClip) {
        if surfaceOrigin == origin, hostOuterClip == outerClip { return }
        surfaceOrigin = origin
        hostOuterClip = outerClip
        layoutMaskHierarchy()
    }

    func setHostOcclusions(_ rects: [HostOcclusionRect]) {
        hostOcclusions = rects
        rebuildMaskHierarchy()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutMaskHierarchy()
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else { return false }
        guard localOuterClipPath()?.contains(point) != false else { return false }
        return !localOcclusionPaths().contains { $0.contains(point) }
    }

    private func localOuterClipPath() -> UIBezierPath? {
        guard let clip = hostOuterClip else { return nil }
        return roundedOuterClipPath(
            rect: CGRect(
                x: CGFloat(clip.x) - surfaceOrigin.x,
                y: CGFloat(clip.y) - surfaceOrigin.y,
                width: CGFloat(clip.width),
                height: CGFloat(clip.height)
            ),
            radii: (
                topLeft: CGFloat(clip.topLeftRadius),
                topRight: CGFloat(clip.topRightRadius),
                bottomRight: CGFloat(clip.bottomRightRadius),
                bottomLeft: CGFloat(clip.bottomLeftRadius)
            )
        )
    }

    private func localOcclusionPaths() -> [UIBezierPath] {
        hostOcclusions.map { occlusion in
            UIBezierPath(
                roundedRect: CGRect(
                    x: CGFloat(occlusion.x) - surfaceOrigin.x,
                    y: CGFloat(occlusion.y) - surfaceOrigin.y,
                    width: CGFloat(occlusion.width),
                    height: CGFloat(occlusion.height)
                ),
                cornerRadius: CGFloat(occlusion.cornerRadius)
            )
        }
    }

    private func rebuildMaskHierarchy() {
        let paths = localOcclusionPaths()
        if maskContainers.count != paths.count {
            contentView?.removeFromSuperview()
            maskContainers.forEach { $0.removeFromSuperview() }
            maskContainers = paths.map { _ in OcclusionMaskContainerView(frame: bounds) }

            var parent: UIView = self
            for container in maskContainers {
                parent.addSubview(container)
                parent = container
            }
        }

        let expectedContentParent: UIView = maskContainers.last ?? self
        if let contentView, contentView.superview !== expectedContentParent {
            expectedContentParent.addSubview(contentView)
        }
        layoutMaskHierarchy()
    }

    private func layoutMaskHierarchy() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        outerClipMask.frame = bounds
        outerClipMask.path = (localOuterClipPath() ?? UIBezierPath(rect: bounds)).cgPath
        CATransaction.commit()
        maskContainers.forEach { $0.frame = bounds }
        contentView?.frame = bounds
        for (container, path) in zip(maskContainers, localOcclusionPaths()) {
            container.setOcclusionPath(path)
        }
    }
}

private func roundedOuterClipPath(
    rect: CGRect,
    radii: (topLeft: CGFloat, topRight: CGFloat, bottomRight: CGFloat, bottomLeft: CGFloat)
) -> UIBezierPath {
    let raw = [
        max(0, radii.topLeft),
        max(0, radii.topRight),
        max(0, radii.bottomRight),
        max(0, radii.bottomLeft),
    ]
    func edgeScale(_ length: CGFloat, _ first: CGFloat, _ second: CGFloat) -> CGFloat {
        let total = first + second
        return total > 0 ? max(0, length) / total : 1
    }
    let scale = [
        CGFloat(1),
        edgeScale(rect.width, raw[0], raw[1]),
        edgeScale(rect.width, raw[3], raw[2]),
        edgeScale(rect.height, raw[0], raw[3]),
        edgeScale(rect.height, raw[1], raw[2]),
    ].min() ?? 1
    let topLeft = raw[0] * scale
    let topRight = raw[1] * scale
    let bottomRight = raw[2] * scale
    let bottomLeft = raw[3] * scale
    let path = UIBezierPath()
    path.move(to: CGPoint(x: rect.minX + topLeft, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX - topRight, y: rect.minY))
    if topRight > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.maxX - topRight, y: rect.minY + topRight),
            radius: topRight,
            startAngle: -.pi / 2,
            endAngle: 0,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRight))
    if bottomRight > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.maxX - bottomRight, y: rect.maxY - bottomRight),
            radius: bottomRight,
            startAngle: 0,
            endAngle: .pi / 2,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY))
    if bottomLeft > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY - bottomLeft),
            radius: bottomLeft,
            startAngle: .pi / 2,
            endAngle: .pi,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + topLeft))
    if topLeft > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.minX + topLeft, y: rect.minY + topLeft),
            radius: topLeft,
            startAngle: .pi,
            endAngle: .pi * 1.5,
            clockwise: true
        )
    }
    path.close()
    return path
}

/// Each wrapper subtracts exactly one rounded hole. Nesting wrappers composes
/// their alpha masks by intersection, so partially overlapping holes remain a
/// union instead of the XOR produced by one even-odd path.
private final class OcclusionMaskContainerView: UIView {
    private let shapeMask = CAShapeLayer()
    private var occlusionPath = UIBezierPath()

    override init(frame: CGRect) {
        super.init(frame: frame)
        shapeMask.fillColor = UIColor.white.cgColor
        shapeMask.fillRule = .evenOdd
        layer.mask = shapeMask
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setOcclusionPath(_ path: UIBezierPath) {
        occlusionPath = path
        updateMask()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateMask()
    }

    private func updateMask() {
        let visiblePath = UIBezierPath(rect: bounds)
        visiblePath.append(occlusionPath)
        shapeMask.frame = bounds
        shapeMask.path = visiblePath.cgPath
    }
}
