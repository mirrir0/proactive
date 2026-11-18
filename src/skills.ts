/**
 * skills.ts — the brain's own instructions, as pi skills.
 *
 * A brain has two kinds of instruction. **Invariants** — never name the machinery,
 * the conclusion is the answer, answer or work but never announce — must hold on
 * every turn, so they belong in the system prompt, where nothing can decline to
 * load them. **Procedures** — how to look for a file, when to reach for a
 * connected service, how to divide a task — only matter when the work matches, so
 * they belong in a skill: advertised by name and description, read when needed.
 *
 * The skills are files at the package root (`skills/<name>/SKILL.md`), which is
 * the layout pi itself discovers. That is deliberate: the same folder is the
 * brain's instruction set and a pi project's skills, so a rule is reviewable in a
 * diff instead of hidden in a template literal.
 *
 * What this module owns is the *allow-list*. A session's default resource loader
 * scans `~/.pi/agent/skills` and `~/.agents/skills` as well as the agent dir, so a
 * brain that does not say otherwise advertises every skill on the machine it
 * happens to run on — measured at 63, none of them the brain's. Every session the
 * brain runs therefore gets a loader whose skills are only the ones under the
 * roots we name: the package's, and the brain's own agent dir (where a member's
 * own would live). One filter, two jobs — the host's machine cannot leak in, and
 * a `SKILL.md` dropped in a member's space folder is not discovered either, even
 * though a Worker's working directory is that folder.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultResourceLoader, defineTool, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Where the brain's built-in skills live.
 *
 * `../skills/` resolves to the package root from both the build (`dist/skills.js`)
 * and the source (`src/skills.ts` under tsx), so the folder never has to be copied
 * into an output directory — and an upgrade replaces it, which is what keeps a
 * skill's version honest.
 */
export const SKILLS_ROOT = fileURLToPath(new URL("../skills/", import.meta.url));

/** The built-ins, as a list a test can hold the folder to. */
export const SKILL_NAMES = ["chat-title", "conclusion", "connected-services", "dispatch", "hands", "subagents"] as const;

export interface SkillRoots {
	/** Where the session runs: a Worker's working directory, the Router's state dir. */
	readonly cwd: string;
	/** The session's pi home: where a member's own skills would be installed. */
	readonly agentDir: string;
	/**
	 * The invariants, appended to the system prompt.
	 *
	 * A rule that must hold on every turn goes here rather than into the turn's own
	 * message: the system prompt is where the harness's own framing is resolved, and
	 * a rule restated every turn competes with the turn's content instead of
	 * governing it.
	 */
	readonly invariants?: readonly string[];
}

/**
 * The roots a session may take skills from, realpath'd.
 *
 * Realpath, because on macOS a temp dir is `/var/folders/…` while its real name is
 * `/private/var/folders/…`, and a prefix test against the wrong one silently keeps
 * nothing.
 */
function allowedRoots(roots: SkillRoots): string[] {
	const candidates = [SKILLS_ROOT, join(roots.agentDir, "skills")];
	return candidates.flatMap((path) => {
		try {
			return [realpathSync(path)];
		} catch {
			return existsSync(path) ? [path] : [];
		}
	});
}

function under(path: string, roots: string[]): boolean {
	const real = (() => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	})();
	return roots.some((root) => real === root || real.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/**
 * A resource loader whose skills are exactly the brain's.
 *
 * Extensions are off: the brain's tools are the ones it hands over, and an
 * extension the machine happens to have installed must not add `subagent` or
 * `todo` to a supervisor. Context files are off too — `AGENTS.md` is read from the
 * working directory, which for a Worker is the member's space folder, and a file
 * there must not become instructions.
 */
export async function brainResourceLoader(roots: SkillRoots): Promise<DefaultResourceLoader> {
	const allowed = allowedRoots(roots);
	const loader = new DefaultResourceLoader({
		cwd: roots.cwd,
		agentDir: roots.agentDir,
		additionalSkillPaths: [SKILLS_ROOT],
		noExtensions: true,
		noContextFiles: true,
		...(roots.invariants === undefined || roots.invariants.length === 0
			? {}
			: { appendSystemPrompt: [...roots.invariants] }),
		skillsOverride: (base) => {
			const skills = base.skills.filter((skill) => under(skill.filePath, allowed));
			const dropped = base.skills.length - skills.length;
			return {
				skills,
				diagnostics: base.diagnostics.filter((diagnostic) => !String(diagnostic.message ?? "").includes("duplicate") || dropped === 0),
			};
		},
	});
	await loader.reload();
	return loader;
}

/** The skills a session would be advertised, for a test or a diagnostic. */
export async function brainSkills(roots: SkillRoots): Promise<Skill[]> {
	const loader = await brainResourceLoader(roots);
	return loader.getSkills().skills;
}

/** A skill's body, without the frontmatter the loader already parsed. */
export function skillBody(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown.trim();
	const end = markdown.indexOf("\n---", 3);
	if (end === -1) return markdown.trim();
	return markdown.slice(markdown.indexOf("\n", end + 1) + 1).trim();
}

/**
 * Read one built-in skill by name.
 *
 * The roots are searched in order, so a member's own skill of the same name would
 * be shadowed by the built-in — the built-in is the one that must hold.
 */
export async function readSkill(name: string, roots: string[] = [SKILLS_ROOT]): Promise<string> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`not a skill name: ${name}`);
	for (const root of roots) {
		const path = join(root, name, "SKILL.md");
		if (!existsSync(path)) continue;
		return skillBody(await readFile(path, "utf8"));
	}
	throw new Error(`no skill called "${name}"`);
}

/** Every built-in skill, by name, for a refusal that can say what exists. */
export async function listSkills(roots: string[] = [SKILLS_ROOT]): Promise<string[]> {
	const names = new Set<string>();
	for (const root of roots) {
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (existsSync(join(root, entry.name, "SKILL.md"))) names.add(entry.name);
		}
	}
	return [...names].sort();
}

/**
 * The tool a session uses to read a skill.
 *
 * pi advertises a skill's name, description and path, and the model reads the file.
 * The Router has no file tools by design — it dispatches instead of looking things
 * up — so the one thing it cannot do is follow that path. This is the smallest
 * thing that makes the skills real rather than decorative: a name in, the
 * instructions out.
 */
export function useSkillTool(roots: string[] = [SKILLS_ROOT]) {
	return defineTool({
		name: "use_skill",
		label: "Read a skill's instructions",
		description: [
			"Read the full instructions of one of your skills, by name.",
			"The skills you have are listed in your system prompt with a one-line description each; this loads the body of the one the work calls for.",
			"Read it before you start the work it describes — the description tells you when it applies.",
		].join("\n"),
		parameters: Type.Object({
			name: Type.String({ description: "The skill's name, as listed." }),
		}),
		exposure: "direct",
		async execute(_id: string, params: { name: string }) {
			try {
				const text = await readSkill(params.name, roots);
				return { content: [{ type: "text" as const, text }], details: { name: params.name, skills: [] as string[] } };
			} catch (err) {
				const names = await listSkills(roots);
				return {
					content: [
						{
							type: "text" as const,
							text: `${(err as Error).message}. Your skills are: ${names.join(", ")}.`,
						},
					],
					details: { name: params.name, skills: names },
					isError: true,
				};
			}
		},
	});
}
