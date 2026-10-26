import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db";
import { oauthAccessTokensTable, oauthRefreshTokensTable } from "../../db/schema";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, hashRefreshToken, makeRefreshToken, validRefreshTokenFormat } from "./refresh-token-crypto";
export { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, makeRefreshToken } from "./refresh-token-crypto";

export async function issueInitialRefresh(
  client_id: string,
  user_id: string,
  scope: string,
  resource: string,
  refreshToken: string,
  accessToken: string,
): Promise<void> {
  const family_id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(oauthRefreshTokensTable).values({
      token_hash: hashRefreshToken(refreshToken),
      family_id,
      client_id,
      user_id,
      scope,
      resource,
      expires_at: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    });
    await tx.insert(oauthAccessTokensTable).values({
      access_token: accessToken,
      client_id,
      user_id,
      scope,
      resource,
      refresh_family_id: family_id,
      expires_at: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000),
    });
  });
}

export type RotateResult =
  | { status: "ok"; scope: string; new_access_token: string; new_refresh_token: string; expires_at: Date }
  | { status: "invalid" | "replayed" };

export async function rotateRefresh(
  refreshToken: string, clientId: string, resource?: string,
): Promise<RotateResult> {
  if (!validRefreshTokenFormat(refreshToken)) return { status: "invalid" };
  const newRefreshToken = makeRefreshToken();
  const newAccessToken = "mcp_token_" + randomBytes(48).toString("base64url");
  const now = new Date();
  return db.transaction(async (tx) => {
    const old = (await tx.select().from(oauthRefreshTokensTable)
      .where(eq(oauthRefreshTokensTable.token_hash, hashRefreshToken(refreshToken)))
      .for("update"))[0];
    if (!old) return { status: "invalid" };
    // Never allow a token to gain another resource or client identity.
    if (old.client_id !== clientId || (resource && old.resource !== resource)) return { status: "invalid" };
    if (old.expires_at <= now || old.revoked_at) return { status: "invalid" };
    if (old.consumed_at) {
      // Replay detected: revoke the entire refresh chain and its live access
      // tokens, not just the already consumed token.
      await tx.update(oauthRefreshTokensTable).set({ revoked_at: now })
        .where(eq(oauthRefreshTokensTable.family_id, old.family_id));
      await tx.delete(oauthAccessTokensTable)
        .where(eq(oauthAccessTokensTable.refresh_family_id, old.family_id));
      return { status: "replayed" };
    }
    // Explicit single-use CAS, with SELECT FOR UPDATE covering concurrent exchanges.
    const consumed = await tx.update(oauthRefreshTokensTable).set({ consumed_at: now })
      .where(and(eq(oauthRefreshTokensTable.token_hash, old.token_hash),
        eq(oauthRefreshTokensTable.family_id, old.family_id)))
      .returning({ token_hash: oauthRefreshTokensTable.token_hash });
    if (consumed.length !== 1) return { status: "invalid" };
    await tx.insert(oauthRefreshTokensTable).values({
      token_hash: hashRefreshToken(newRefreshToken),
      family_id: old.family_id,
      client_id: old.client_id,
      user_id: old.user_id,
      scope: old.scope,
      resource: old.resource,
      expires_at: old.expires_at,
    });
    await tx.insert(oauthAccessTokensTable).values({
      access_token: newAccessToken,
      client_id: old.client_id,
      user_id: old.user_id,
      scope: old.scope,
      resource: old.resource,
      refresh_family_id: old.family_id,
      expires_at: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
    });
    return {
      status: "ok",
      scope: old.scope,
      new_access_token: newAccessToken,
      new_refresh_token: newRefreshToken,
      expires_at: old.expires_at,
    };
  });
}

export async function revokeRefresh(refreshToken: string): Promise<void> {
  if (!validRefreshTokenFormat(refreshToken)) return;
  await db.transaction(async (tx) => {
    const match = (await tx.select({ family_id: oauthRefreshTokensTable.family_id })
      .from(oauthRefreshTokensTable)
      .where(eq(oauthRefreshTokensTable.token_hash, hashRefreshToken(refreshToken)))
      .limit(1))[0];
    if (!match) return;
    await tx.update(oauthRefreshTokensTable)
      .set({ revoked_at: new Date() })
      .where(eq(oauthRefreshTokensTable.family_id, match.family_id));
    await tx.delete(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.refresh_family_id, match.family_id));
  });
}

export async function cleanupExpiredRefresh(): Promise<void> {
  await db.delete(oauthRefreshTokensTable)
    .where(lt(oauthRefreshTokensTable.expires_at, new Date()));
}
