import { initialize } from "../single-file-cli-api.js";
import { startDownloadServer } from "./download-server.ts";
import { getBrowserPath } from "./fixtures.ts";
Deno.test({
  name: "a closing page does not reset the download directory",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const outputDirectory = `${await Deno.makeTempDir({
      dir: Deno.cwd(),
      prefix: "download-behavior-test-",
    })}/`;
    const server = startDownloadServer();
    let singleFile: Awaited<ReturnType<typeof initialize>> | undefined;
    try {
      singleFile = await initialize({
        browserExecutablePath: await getBrowserPath(),
        browserHeadless: true,
        browserLoadMaxTime: 15000,
        browserCaptureMaxTime: 15000,
        browserWaitUntil: "load",
        browserWaitUntilDelay: 0,
        crawlDownloads: true,
        outputDirectory,
        maxParallelWorkers: 2,
      });
      await singleFile.capture([server.pageUrl, server.downloadUrl]);
      const content = await Deno.readTextFile(`${outputDirectory}download.bin`);
      if (content !== "persistent download") {
        throw new Error(`Unexpected download content: ${content}`);
      }
    } finally {
      if (singleFile) {
        await singleFile.finish().catch(() => {});
      }
      await server.close();
      await Deno.remove(outputDirectory, { recursive: true });
    }
  },
});
