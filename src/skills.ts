/**
 * The brain's instructions as pi skills (`skills/<name>/SKILL.md`): invariants in the system
 * prompt, procedures in a skill. This module owns the allow-list, so the machine's own pi
 * home cannot leak in.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultResourceLoader, defineTool, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

	/** `../skills/` resolves from both `dist/` and `src/`, so nothing is copied. */
export const SKILLS_ROOT = fileURLToPath(new URL("../skills/", import.meta.url));

/** The built-ins, as a list a test can hold the folder to. */
export const SKILL_NAMES = ["chat-title", "conclusion", "connected-services", "dispatch", "hands", "subagents"] as const;

export interface SkillRoots {
	/** Where the session runs: a Worker's working directory, the Router's state dir. */
	readonly cwd: string;
	/** The session's pi home: where a member's own skills would be installed. */
	readonly agentDir: string;
		/** A rule that must never be optional cannot be restated in each turn's message. */
	readonly invariants?: readonly string[];
		/** Replaces pi's coding-agent preamble and its tool, rules and documentation sections. */
	readonly systemPrompt?: string;
		/** A Worker's cwd is its hand's root and is true; a Router has none, and any path it sees it may quote. */
	readonly hideCwd?: boolean;
}

	/** Realpath: on macOS a temp dir is `/var/…` and its real name `/private/var/…`. */
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

	/** Extensions off, and context files off: `AGENTS.md` in a space folder is not instructions. */
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
		...(roots.systemPrompt === undefined ? {} : { systemPrompt: roots.systemPrompt }),
		...(roots.hideCwd === true
			? { systemPromptOverride: (base: string | undefined) => (base ?? "").replace(/<cwd>[\s\S]*?<\/cwd>\n?/, "") }
			: {}),
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

	/** pi renders a skills section only when the session has `read` or `bash`, which neither has. */
export async function skillCatalogue(): Promise<string> {
	const skills = await Promise.all(
		SKILL_NAMES.map(async (name) => {
			const body = await readSkill(name).catch(() => undefined);
			if (body === undefined) return undefined;
			const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
			return `- \`${name}\`: ${description}`;
		}),
	);
	const listed = skills.filter((line): line is string => line !== undefined);
	if (listed.length === 0) return "";
	return [
		"You have skills: procedures for a kind of work, written down so you do not have to remember them.",
		"Call `use_skill` with a name before doing that kind of work. They are short.",
		...listed,
	].join("\n");
}

/** A skill's body, without the frontmatter the loader already parsed. */
export function skillBody(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown.trim();
	const end = markdown.indexOf("\n---", 3);
	if (end === -1) return markdown.trim();
	return markdown.slice(markdown.indexOf("\n", end + 1) + 1).trim();
}

	/** Searched in order: the built-in is the one that must hold. */
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

	/** The Router has no file tools, so this is what makes a skill reachable at all. */
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
