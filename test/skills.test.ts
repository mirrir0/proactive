/**
 * The brain's skills.
 *
 * What these hold: that a session is advertised the brain's own skills and
 * nothing else, that the allow-list is what keeps the host machine out, and that
 * `use_skill` reads a real body and refuses an unknown name with the list.
 *
 * The leak being tested is not hypothetical. Before this, the Router session
 * passed no resource loader, so the SDK built the default one — which scans
 * `~/.pi/agent/skills` as well as the agent dir. Measured on a developer machine:
 * 63 skills advertised, none of them the brain's.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	SKILL_NAMES,
	SKILLS_ROOT,
	brainResourceLoader,
	brainSkills,
	listSkills,
	readSkill,
	skillBody,
	skillCatalogue,
	useSkillTool,
} from "../src/skills.ts";

function tempDir(prefix = "mir-skills-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function plant(root: string, name: string, description = `The ${name} skill.`): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(
		join(root, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`,
	);
}

test("a session is advertised the brain's own skills", async () => {
	const dir = tempDir();
	const skills = await brainSkills({ cwd: dir, agentDir: join(dir, "agent") });
	const names = skills.map((skill) => skill.name).sort();
	assert.deepEqual(names, [...SKILL_NAMES], "exactly the built-ins, nothing else");
});

test("every advertised skill is a file under the brain's own roots", async () => {
	// The property, not the count: whatever else is on this machine, a skill a
	// session can see came from the package or from its own agent dir.
	const dir = tempDir();
	const agentDir = join(dir, "agent");
	const skills = await brainSkills({ cwd: dir, agentDir });
	for (const skill of skills) {
		assert.ok(
			skill.filePath.startsWith(SKILLS_ROOT) || skill.filePath.startsWith(agentDir),
			`${skill.name} came from ${skill.filePath}, which is not a brain root`,
		);
	}
});

test("a skill in the working directory is not discovered, even though it is there", async () => {
	// A Worker's working directory is the member's space, and a space can be
	// shared. A `SKILL.md` in it is a teammate's text, not an instruction this
	// brain follows — so the loader's cwd does not grant skills.
	const dir = tempDir();
	plant(dir, "from-the-folder", "Instructions someone dropped in a folder.");
	const skills = await brainSkills({ cwd: dir, agentDir: join(dir, "agent") });
	assert.ok(
		!skills.some((skill) => skill.name === "from-the-folder"),
		"a skill in the working directory reached the session",
	);
});

test("a skill in the session's own agent dir is discovered", async () => {
	// The other half of the allow-list: what a brain installs for itself is real.
	const dir = tempDir();
	const agentDir = join(dir, "agent");
	plant(join(agentDir, "skills"), "mine", "A skill this brain installed for itself.");
	const skills = await brainSkills({ cwd: dir, agentDir });
	const names = skills.map((skill) => skill.name);
	assert.ok(names.includes("mine"), `expected the agent dir's skill, saw ${names.join(", ")}`);
	assert.ok(names.includes("dispatch"), "and the built-ins are still there");
});

test("a skill's body is its instructions, without the frontmatter", async () => {
	const body = await readSkill("dispatch");
	assert.ok(body.length > 200, "the dispatch skill has its instructions");
	assert.ok(!body.startsWith("---"), "the frontmatter is not part of the body");
	// Prose wraps in the file, so the assertion reads it as a sentence.
	assert.match(body.replace(/\s+/g, " "), /If you are unsure whether it is a quick reply, it is not a quick reply/);
});

test("every built-in is a real, loadable skill with a routing description", async () => {
	for (const name of SKILL_NAMES) {
		const body = await readSkill(name);
		assert.ok(body.length > 100, `${name} has instructions`);
	}
	// The description is what decides whether the model loads it, so it has to say
	// when the skill applies, not only what it is.
	const skills = await brainSkills({ cwd: tempDir(), agentDir: join(tempDir(), "agent") });
	for (const skill of skills) {
		assert.match(
			skill.description ?? "",
			/\bUse\b/,
			`${skill.name}'s description does not say when to use it`,
		);
	}
});

test("use_skill returns the body, and an unknown name says what exists", async () => {
	const tool = useSkillTool();
	const found = await tool.execute("call-1", { name: "conclusion" }, undefined, undefined, undefined as never);
	const text = (found.content[0] as { text: string }).text;
	assert.match(text, /The last assistant message after your last tool call is the answer/);

	const missing = await tool.execute("call-2", { name: "nope" }, undefined, undefined, undefined as never);
	const said = (missing.content[0] as { text: string }).text;
	assert.equal(missing.isError, true);
	assert.match(said, /no skill called "nope"/);
	assert.match(said, /Your skills are: chat-title, conclusion, connected-services, dispatch, hands, subagents/);
});

test("a skill name cannot walk out of the skills folder", async () => {
	await assert.rejects(() => readSkill("../../etc/passwd"), /not a skill name/);
});

test("the frontmatter is stripped wherever it ends", () => {
	assert.equal(skillBody("---\nname: x\n---\n\nBody.\n"), "Body.");
	assert.equal(skillBody("no frontmatter here"), "no frontmatter here");
});

test("the listed skills are the folder's, sorted", async () => {
	assert.deepEqual(await listSkills(), [...SKILL_NAMES]);
});

test("the Router's prompt is its own: no coding-assistant framing, no path, and it lists its skills", async () => {
	const dir = tempDir("mir-prompt-");
	const loader = await brainResourceLoader({
		cwd: dir,
		agentDir: join(dir, "agent"),
		invariants: ["an invariant"],
		systemPrompt: ["You are one person's assistant, in a chat with them.", await skillCatalogue()]
			.filter((part) => part !== "")
			.join("\n\n"),
		hideCwd: true,
	});
	const rendered = (await loader.getSystemPrompt()) ?? "";
	// pi's preamble is gone, and with it the directory it would have named — a Router
	// has no filesystem, and a path in its prompt is a path it quotes as the person's.
	assert.equal(/coding assistant running inside pi/.test(rendered), false, "not pi's preamble");
	assert.equal(rendered.includes(dir), false, "no working directory in the prompt");
	assert.match(rendered, /You are one person's assistant/, "its own framing");
	assert.match(rendered, /use_skill/, "and how to read a skill");
	assert.match(rendered, /`dispatch`/, "the skills listed by name");
});
