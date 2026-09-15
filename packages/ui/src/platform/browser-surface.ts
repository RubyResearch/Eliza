import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";

/** Renderer implementation hint shared by text and voice; never authority. */
export function getClientBrowserSurface(): "native" | undefined {
  return Capacitor.isNativePlatform() && !isElectrobunRuntime()
    ? "native"
    : undefined;
}
