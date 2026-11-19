/**
 * tokens.ts — who a client is, as a token the daemon can verify without a database.
 *
 * One mir serves several members, so the client API cannot have one shared secret
 * that means "somebody": a token has to say *which* member it is for, and it has to
 * be unforgeable without the secret both sides already hold.
 *
 * The format is deliberately boring:
 *
 *     v1.<base64url(member)>.<base64url(HMAC-SHA256(secret, "v1." + member))>
 *
 * Three properties, and they are the whole reason for the shape:
 *
 *   - **Stateless.** The daemon verifies with the secret it was started with; there
 *     is no session table to keep, expire or lose. A member the stack removes is
 *     removed by rotating the secret, not by a revocation list.
 *   - **Named.** The member is inside the signed payload, so two members cannot
 *     present each other's token and be told they are the same person.
 *   - **Comparable in constant time.** The signature is compared with
 *     `timingSafeEqual`, like the hand tokens, because a byte-at-a-time comparison
 *     is a byte-at-a-time oracle.
 *
 * A static `MIR_API_TOKEN` still works and maps to one member — that is a
 * single-member install, and it is what `mir serve` has always meant. It is not a
 * fallback for a *failed* signature: a bad signature is refused, never downgraded.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The member a static (unsigned) token belongs to. */
export const DEFAULT_MEMBER = "local";

const VERSION = "v1";

function sign(secret: string, member: string): string {
	return createHmac("sha256", secret).update(`${VERSION}.${member}`).digest("base64url");
}

/** A token for one member. The issuer (a host) and the verifier (mir) share `secret`. */
export function signMemberToken(secret: string, member: string): string {
	if (secret === "") throw new Error("a signed token needs a secret");
	if (member === "") throw new Error("a signed token needs a member");
	return `${VERSION}.${Buffer.from(member, "utf8").toString("base64url")}.${sign(secret, member)}`;
}

/** The member a token names, or undefined when it is not one this secret signed. */
export function verifyMemberToken(secret: string, token: string): string | undefined {
	if (secret === "" || token === "") return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
	const [, payload = "", presented = ""] = parts;
	let member: string;
	try {
		member = Buffer.from(payload, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	if (member === "") return undefined;
	const expected = sign(secret, member);
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	// Length first: `timingSafeEqual` throws on a mismatch, which would be a crash
	// for a client that sent rubbish.
	if (a.length !== b.length) return undefined;
	return timingSafeEqual(a, b) ? member : undefined;
}
