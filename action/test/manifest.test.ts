import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface Manifest {
  inputs: Record<string, { required?: boolean; default?: string }>;
  runs: { using: string; steps: { id?: string; env?: Record<string, string> }[] };
}

interface Workflow {
  jobs: { review: { if: string; permissions: Record<string, string>; steps: { uses?: string; with?: Record<string, string> }[] } };
}

const read = async (path: string) => Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, "..", path)).text());

describe("action manifest", () => {
  test("parses and exposes only the api_url, token and opencode inputs", async () => {
    const manifest = (await read("action.yml")) as Manifest;
    expect(Object.keys(manifest.inputs).sort()).toEqual(["api_url", "github_token", "opencode_version"]);
    expect(manifest.inputs.api_url?.required).toBe(true);
    expect(manifest.inputs.github_token?.default).toBe("${{ github.token }}");
    expect(manifest.runs.using).toBe("composite");
    const run = manifest.runs.steps.find((step) => step.id === "run");
    expect(run?.env?.INPUT_API_URL).toBe("${{ inputs.api_url }}");
    expect(run?.env?.INPUT_GITHUB_TOKEN).toBe("${{ inputs.github_token }}");
  });

  test("the self review workflow runs the published action against the hosted API with only the id token and a shrike comment filter", async () => {
    const { jobs } = (await read("../.github/workflows/shrike.yml")) as Workflow;
    expect(jobs.review.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(jobs.review.if).toContain("startsWith(github.event.comment.body, 'shrike')");
    const step = jobs.review.steps.find((candidate) => candidate.uses === "AfterMatter/shrike-ci/action@main");
    expect(step?.with).toEqual({ api_url: "https://shriken.vercel.app" });
  });
});
