const BROWSER_PATHS = [
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/usr/bin/google-chrome",
];

export async function getBrowserPath(): Promise<string> {
  const configuredPath = Deno.env.get("CHROMIUM_PATH");
  if (configuredPath) {
    return configuredPath;
  }
  for (const browserPath of BROWSER_PATHS) {
    try {
      await Deno.stat(browserPath);
      return browserPath;
    } catch {
      // Try the next supported browser path.
    }
  }
  throw new Error(
    "Chromium not found; set CHROMIUM_PATH to run integration tests",
  );
}
