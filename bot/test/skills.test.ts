import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listSkills, loadSkill, parseSkill } from "../src/skills";

const BUILTIN = resolve(import.meta.dir, "../../skills");

async function skillDir(root: string, name: string, raw: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), raw);
}

describe("parseSkill", () => {
  test("reads name, description and body", () => {
    const skill = parseSkill('---\nname: my-skill\ndescription: "Does things."\nmetadata:\n  author: x\n---\nBody line 1\n\nBody line 2\n', "/x/my-skill");
    expect(skill).toEqual({ name: "my-skill", description: "Does things.", body: "Body line 1\n\nBody line 2", dir: "/x/my-skill" });
  });

  test("rejects missing frontmatter, bad names and empty descriptions", () => {
    expect(() => parseSkill("no frontmatter", "/x")).toThrow(/frontmatter/);
    expect(() => parseSkill("---\nname: Bad_Name\ndescription: d\n---\nb", "/x")).toThrow(/invalid name/);
    expect(() => parseSkill("---\nname: -bad\ndescription: d\n---\nb", "/x")).toThrow(/invalid name/);
    expect(() => parseSkill("---\nname: ok\n---\nb", "/x")).toThrow(/description/);
  });
});

describe("loadSkill", () => {
  test("searches directories in order and enforces directory name", async () => {
    const first = await mkdtemp(join(tmpdir(), "skills-a-"));
    const second = await mkdtemp(join(tmpdir(), "skills-b-"));
    await skillDir(second, "code-review", "---\nname: code-review\ndescription: custom\n---\ncustom body");
    await skillDir(second, "mismatch", "---\nname: other\ndescription: d\n---\nb");
    expect((await loadSkill("code-review", [first, second])).body).toBe("custom body");
    expect((await loadSkill("code-review", [second, BUILTIN])).description).toBe("custom");
    expect((await loadSkill("code-review", [BUILTIN, second])).description).not.toBe("custom");
    await expect(loadSkill("mismatch", [second])).rejects.toThrow(/declares name/);
    await expect(loadSkill("missing", [first, second])).rejects.toThrow(/not found/);
    await expect(loadSkill("../escape", [second])).rejects.toThrow(/invalid skill name/);
  });

  test("built-in skills all load and match their directory", async () => {
    const skills = await listSkills([BUILTIN]);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["cleanup", "code-review", "react-doctor", "security-review", "slop-review", "suggest-changes"]);
    for (const skill of skills) {
      expect(skill.body.length).toBeGreaterThan(200);
      expect(skill.body).not.toMatch(/```json/);
    }
  });
});
