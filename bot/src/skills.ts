// Loads SKILL.md files by name from ordered skill directories.
// Frontmatter gives name and description, body is the prompt.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseSkill(raw: string, dir: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`SKILL.md in ${dir} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1]!, field[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  const name = fields.get("name") ?? "";
  if (!NAME.test(name) || name.length > 64) throw new Error(`SKILL.md in ${dir} has invalid name "${name}"`);
  const description = fields.get("description") ?? "";
  if (!description) throw new Error(`skill ${name} has no description`);
  return { name, description, body: match[2]!.trim(), dir };
}

export async function loadSkill(name: string, dirs: string[]): Promise<Skill> {
  if (!NAME.test(name)) throw new Error(`invalid skill name "${name}"`);
  for (const root of dirs) {
    const dir = join(root, name);
    const raw = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
    if (raw === null) continue;
    const skill = parseSkill(raw, dir);
    if (skill.name !== name) throw new Error(`skill directory ${dir} declares name "${skill.name}"`);
    return skill;
  }
  throw new Error(`skill "${name}" not found in ${dirs.join(", ")}`);
}

export async function listSkills(dirs: string[]): Promise<Skill[]> {
  const seen = new Map<string, Skill>();
  for (const root of dirs) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const skill = await loadSkill(entry.name, [root]).catch(() => null);
      if (skill) seen.set(skill.name, skill);
    }
  }
  return [...seen.values()];
}
