// Test app for the capture step: answers with marker.txt of its directory on
// the given port, or with "idle" never listens so the start timeout can be tested.
import { readFileSync } from "node:fs";

const port = Number(process.argv[2]);
if (process.argv[3] === "idle") setInterval(() => {}, 60_000);
else {
  Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response(readFileSync("marker.txt", "utf8")) });
  console.log(`listening on ${port}`);
}
