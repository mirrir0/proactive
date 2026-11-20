/**
 * Who a client is, verified without a database.
 *
 *     v1.<base64url(member)>.<base64url(HMAC-SHA256(secret, "v1." + member))>
 *
 * A static `MIR_API_TOKEN` still maps to one member. It is not a fallback for a failed
 * signature: a bad signature is refused, never downgraded.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The member a static (unsigned) token belongs to. */
export const DEFAULT_MEMBER = "local";

const VERSION = "v1";

function sign(secret: string, member: string): string {
	return createHmac("sha256", secret).update(`${VERSION}.${member}`).digest("base64url");
}

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
	// `timingSafeEqual` throws on a length mismatch, so check it first.
	if (a.length !== b.length) return undefined;
	return timingSafeEqual(a, b) ? member : undefined;
}
