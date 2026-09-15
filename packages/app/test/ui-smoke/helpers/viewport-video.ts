/** Records each synthetic UI journey at its requested viewport size while retaining normal Playwright page, tracing and diagnostic fixtures. */
import { test as base, type Video } from "@playwright/test";

export const test = base.extend({
  context: async ({ browser, viewport, contextOptions }, use, testInfo) => {
    if (!viewport)
      throw new Error("Viewport-sized recordings require an explicit viewport");
    const context = await browser.newContext({
      ...contextOptions,
      viewport,
      recordVideo: { dir: testInfo.outputPath("raw-video"), size: viewport },
    });
    let videos: Array<Video | null> = [];
    try {
      await use(context);
    } finally {
      videos = context.pages().map((page) => page.video());
      await context.close();
    }
    for (const [index, video] of videos.entries()) {
      if (!video)
        throw new Error(
          "A journey page did not produce its required recording",
        );
      await video.saveAs(
        testInfo.outputPath(index === 0 ? "video.webm" : `video-${index}.webm`),
      );
    }
  },
});
