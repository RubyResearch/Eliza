export function rendererDistMatchesPlaywrightTestAuth(
  appDir: string,
  expectedPlaywrightTestAuth: boolean,
): boolean;

export function resolvePlaywrightTestAuth(appDir: string): boolean;

export function viteRendererBuildNeeded(
  appDir: string,
  repoRoot: string,
  options?: { expectedPlaywrightTestAuth?: boolean },
): boolean;
