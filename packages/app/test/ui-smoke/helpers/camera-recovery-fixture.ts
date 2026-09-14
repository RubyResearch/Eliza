/**
 * Drives the real browser camera bridge from denied permission to a synthetic
 * canvas video stream. This proves renderer recovery, not physical camera access.
 */
import type { Page } from "@playwright/test";

export async function installCameraRecoveryFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let videoAttempts = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (!constraints.video || ++videoAttempts <= 2) {
          throw new DOMException(
            "Synthetic camera access denied",
            "NotAllowedError",
          );
        }
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Synthetic camera canvas is unavailable");
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        const draw = () => {
          if (track.readyState === "ended") return;
          context.fillStyle = "#ff6a1f";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#000000";
          context.font = "24px sans-serif";
          context.fillText("Synthetic camera recovery fixture", 20, 60);
          requestAnimationFrame(draw);
        };
        draw();
        return stream;
      },
    });
  });
}
