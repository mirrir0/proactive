/**
 * Who a client is, when one daemon serves several members.
 *
 * A token has to say *which* member it is for, be unforgeable without the shared
 * secret, and be refused rather than downgraded when it is wrong — a fallback to the
 * static token on a failed signature would make the secret optional for an attacker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MEMBER, signMemberToken, verifyMemberToken } from "../src/api/tokens.ts";

const SECRET = "the-secret-both-sides-hold";

test("a signed token names its member, and verifying it gives that member back", () => {
	for (const member of ["dev-user", "ana", "member-with-dashes", "üñí"]) {
		const token = signMemberToken(SECRET, member);
		assert.equal(verifyMemberToken(SECRET, token), member);
	}
});

test("two members cannot present each other's token", () => {
	const ana = signMemberToken(SECRET, "ana");
	const bo = signMemberToken(SECRET, "bo");
	assert.equal(verifyMemberToken(SECRET, ana), "ana");
	assert.equal(verifyMemberToken(SECRET, bo), "bo");
	assert.notEqual(ana, bo);
});

test("a token signed with another secret is not one this daemon accepts", () => {
	const token = signMemberToken("another-secret", "ana");
	assert.equal(verifyMemberToken(SECRET, token), undefined);
});

test("a tampered payload is refused: the member is inside the signature", () => {
	const token = signMemberToken(SECRET, "ana");
	const [, , signature] = token.split(".");
	const forged = `v1.${Buffer.from("root", "utf8").toString("base64url")}.${signature}`;
	assert.equal(verifyMemberToken(SECRET, forged), undefined, "swapping the member invalidates the signature");
});

test("rubbish is refused without throwing", () => {
	for (const bad of ["", "v1", "v1.", "v1.a.b.c", "not-a-token", "v2.abc.def", "v1..sig"]) {
		assert.equal(verifyMemberToken(SECRET, bad), undefined, `accepted ${JSON.stringify(bad)}`);
	}
});

test("no secret, no signed tokens", () => {
	assert.throws(() => signMemberToken("", "ana"), /needs a secret/);
	assert.equal(verifyMemberToken("", signMemberToken(SECRET, "ana")), undefined);
});

test("the static token belongs to one member, by name", () => {
	// What a single-member install does: `MIR_API_TOKEN` is the way in, and the member
	// it speaks for is `MIR_API_MEMBER` (or `local`).
	assert.equal(DEFAULT_MEMBER, "local");
});
