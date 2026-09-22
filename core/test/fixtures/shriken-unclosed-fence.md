This PR is a throwaway run to check the review-structure change against a pinned action branch [commit:96ccd4f]. Its real content, in [commit:3fd74e4], lets one finding span several places and folds what each finished review wrote onto the card [file:core/src/card.ts:90]. The `related` spots flow through the shared `spotAt` and `findingLines` helpers into the Shriken and autofix prompts [file:core/src/prompt.ts] and are linked in the posted threads [file:core/src/threads.ts]. A second commit adds an unbound `demo/` uploads endpoint [file:demo/server.ts], and the action branch is pinned to `forloopcodes/shr-4-review-structure-update` [file:.github/workflows/shrike.yml].

The handler takes the `file` query parameter unvalidated, so a request can read or delete anything the process can reach on an endpoint with no authentication [file:demo/server.ts:6]:

```diff
+import { readUpload, removeUpload } from "./uploads";
+
+Bun.serve({
+  port: 8080,
+  async fetch(request) {
+    const name = new URL(request.url).searchParams.get("file") ?? "";
```

Three reviews converge on that hole: both code-review and slop-review independently call it a path traversal, `?file=../package.json` reading and `DELETE` deleting any reachable file [finding:code-review#1] [finding:slop-review#1]. code-review also flags fence balance only guarding the 3000-character cut, not a short summary with an odd number of fences [finding:code-review#2], and `related` ranges that can invert and leak broken `#L9-L3` anchors into thread bodies [finding:code-review#3]. cleanup confirms the demo is dead code, absent from [file:tsconfig.json] and the workspaces, and notes the README misses the new folded notes [finding:cleanup#1] [finding:cleanup#2]; house-style passes [review:house-style]. The suggested fix constrains the name before it reaches the filesystem [finding:code-review#1]:

```suggestion
const name = new URL(request.url).searchParams.get("file") ?? "";
if (request.method === "DELETE") {
  try { await removeUpload("uploads", name); } catch { return new Response(null, { status: 404 }); }
  return new Response(null, { status: 204 });
}
try {
  return new Response(await readUpload("uploads", name));
} catch {
  return new Response("not found", { status: 404 });
}
