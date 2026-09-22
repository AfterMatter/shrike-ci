import { readUpload, removeUpload } from "./uploads";

Bun.serve({
  port: 8080,
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("file") ?? "";
    if (request.method === "DELETE") {
      await removeUpload("uploads", name);
      return new Response(null, { status: 204 });
    }
    return new Response(await readUpload("uploads", name));
  },
});
