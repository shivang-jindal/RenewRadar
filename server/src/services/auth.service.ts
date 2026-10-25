/**
 * Authentication (Part A / A5).
 *
 * Session strategy: an opaque 256-bit random token is issued in a secure,
 * HTTP-only, SameSite cookie. Only its SHA-256 hash is stored, so a database
 * leak cannot be replayed as a login. Passwords use Argon2id from
 * `@node-rs/argon2`; no hashing, cookie signing or OAuth flow is implemented
 * from scratch.
 */

import { and, eq, isNull } from 'drizzle-orm';

import type { AuthSessionResponse, MembershipSummary, SessionUser } from '@renewradar/shared';
import { permissionsForRole, type Role } from '@renewradar/shared';

import type { AppDatabase } from '../db/client.js';
import { memberships, organizations, passwordResetTokens, sessions, users } from '../db/schema.js';
import { badRequest, conflict, integrationUnavailable, notFound, unauthenticated, unprocessable } from '../errors.js';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.js';
import { GoogleTokenError, verifyFirebaseIdToken, type GoogleIdentity } from '../lib/firebase.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  userId: string;
}

export interface AuthenticatedPrincipal {
  user: SessionUser;
  sessionId: string;
  activeOrganizationId: string | null;
}

export class AuthService {
  constructor(
    private readonly db: AppDatabase,
    private readonly sessionTtlHours: number,
    private readonly firebaseProjectId: string | null = null,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    meta?: { ipAddress?: string | null; userAgent?: string | null };
  }): Promise<{ user: SessionUser; session: IssuedSession }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) {
      throw conflict('An account with that email already exists.', { field: 'email' });
    }

    const passwordHash = await hashPassword(input.password);
    const inserted = await this.db
      .insert(users)
      .values({ email, passwordHash, displayName: input.displayName.trim() })
      .returning();

    const user = inserted[0]!;
    const session = await this.createSession(user.id, input.meta);
    return { user: toSessionUser(user), session };
  }

  async signIn(input: {
    email: string;
    password: string;
    meta?: { ipAddress?: string | null; userAgent?: string | null };
  }): Promise<{ user: SessionUser; session: IssuedSession }> {
    const email = input.email.trim().toLowerCase();
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];

    // Always run a verification so a missing account and a wrong password take
    // a comparable amount of time.
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(storedHash, input.password);

    if (!user || !user.passwordHash || !ok) {
      throw unauthenticated('Email or password is incorrect.');
    }
    if (user.disabledAt) {
      throw unauthenticated('This account has been disabled.');
    }

    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const session = await this.createSession(user.id, input.meta);
    return { user: toSessionUser(user), session };
  }

  /**
   * Signs in with a Firebase ID token obtained from a Google popup.
   *
   * The token is the only credential: it is verified against Google's published
   * keys and this project before any claim is used. Accounts are matched by
   * verified email, so a person who already signs in with a password keeps the
   * same account. A Google-created account has no password hash at all, so it
   * cannot later be entered through the password form.
   */
  async signInWithGoogle(input: {
    idToken: string;
    meta?: { ipAddress?: string | null; userAgent?: string | null };
  }): Promise<{ user: SessionUser; session: IssuedSession }> {
    if (!this.firebaseProjectId) {
      throw integrationUnavailable('Google sign-in is not configured on this server.');
    }

    let identity: GoogleIdentity;
    try {
      identity = await verifyFirebaseIdToken(input.idToken, this.firebaseProjectId);
    } catch (error) {
      if (error instanceof GoogleTokenError) {
        throw unauthenticated('Google sign-in could not be verified. Please try again.');
      }
      throw error;
    }

    const email = identity.email;
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    let user = rows[0];

    if (!user) {
      await this.db
        .insert(users)
        .values({
          email,
          passwordHash: null,
          displayName: identity.displayName ?? email.split('@')[0]!.slice(0, 120),
        })
        .onConflictDoNothing();
      const [created] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!created) {
        throw unauthenticated('Google sign-in could not be completed. Please try again.');
      }
      user = created;
    }

    if (user.disabledAt) {
      throw unauthenticated('This account has been disabled.');
    }

    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const session = await this.createSession(user.id, input.meta);
    return { user: toSessionUser(user), session };
  }

  async createSession(
    userId: string,
    meta?: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<IssuedSession> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3_600_000);
    await this.db.insert(sessions).values({
      userId,
      tokenHash: sha256Hex(token),
      expiresAt,
      ipAddress: meta?.ipAddress ?? null,
      userAgent: meta?.userAgent?.slice(0, 300) ?? null,
    });
    return { token, expiresAt, userId };
  }

  async authenticate(token: string | undefined): Promise<AuthenticatedPrincipal | null> {
    if (!token) return null;
    const rows = await this.db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        activeOrganizationId: sessions.activeOrganizationId,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        createdAt: users.createdAt,
        disabledAt: users.disabledAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.disabledAt) return null;

    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        createdAt: row.createdAt.toISOString(),
      },
      sessionId: row.sessionId,
      activeOrganizationId: row.activeOrganizationId,
    };
  }

  async revokeSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256Hex(token)));
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async setActiveOrganization(sessionId: string, organizationId: string | null): Promise<void> {
    await this.db
      .update(sessions)
      .set({ activeOrganizationId: organizationId })
      .where(eq(sessions.id, sessionId));
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user?.passwordHash) throw notFound('Account');
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw badRequest('Your current password is incorrect.', { currentPassword: ['Incorrect password'] });
    }
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw unprocessable('Choose a password you have not used here before.', {
        newPassword: ['New password must differ from the current one'],
      });
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));
    // Force every other device to sign in again.
    await this.revokeAllSessions(userId);
  }

  async updateProfile(userId: string, displayName: string | undefined) {
    const [row] = await this.db
      .update(users)
      .set({ ...(displayName ? { displayName: displayName.trim() } : {}), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!row) throw notFound('Account');
    return toSessionUser(row);
  }

  async requestPasswordReset(email: string): Promise<{ token: string | null; userId: string }> {
    const normalized = email.trim().toLowerCase();
    const rows = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    const user = rows[0];
    if (!user) {
      // Still return a value so the caller behaves identically either way.
      return { token: null, userId: '' };
    }
    const token = randomToken(32);
    await this.db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    return { token, userId: user.id };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, sha256Hex(token)), isNull(passwordResetTokens.usedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw badRequest('This reset link is invalid or has expired.');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
        .where(eq(users.id, row.userId));
      await tx.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id));
    });
    await this.revokeAllSessions(row.userId);
  }

  async membershipsFor(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        baseCurrency: organizations.baseCurrency,
        timezone: organizations.timezone,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(organizations.createdAt);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      organizationSlug: row.organizationSlug,
      baseCurrency: row.baseCurrency,
      timezone: row.timezone,
      role: row.role as Role,
      permissions: permissionsForRole(row.role as Role),
    }));
  }

  async sessionPayload(userId: string, activeOrganizationId: string | null): Promise<AuthSessionResponse> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw notFound('Account');
    const list = await this.membershipsFor(userId);
    return {
      user: toSessionUser(user),
      memberships: list,
      activeOrganizationId:
        activeOrganizationId && list.some((m) => m.organizationId === activeOrganizationId)
          ? activeOrganizationId
          : (list[0]?.organizationId ?? null),
    };
  }
}

/** A valid Argon2 hash of a value nobody can sign in with. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4MDAwMDAwMDA';

export function toSessionUser(row: typeof users.$inferSelect): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}