export interface DownloadServer {
  pageUrl: string;
  downloadUrl: string;
  close: () => Promise<void>;
}
export function startDownloadServer(responseDelay = 3000): DownloadServer {
  let notifyDownloadRequest: () => void = () => {};
  const downloadRequested = new Promise<void>((resolve) => {
    notifyDownloadRequest = resolve;
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/page") {
        await downloadRequested;
        return new Response("<!doctype html><title>Fast page</title>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/download") {
        notifyDownloadRequest();
        await new Promise((resolve) => setTimeout(resolve, responseDelay));
        return new Response("persistent download", {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename=download.bin",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const baseUrl = `http://127.0.0.1:${server.addr.port}`;
  return {
    pageUrl: `${baseUrl}/page`,
    downloadUrl: `${baseUrl}/download`,
    close: () => server.shutdown(),
  };
}
