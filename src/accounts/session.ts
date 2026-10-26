/** The slice of Supabase Auth the AI client needs; structural, so tests pass fakes. */
export interface AuthLike {
  getSession(): Promise<{
    data: { session: { access_token: string } | null };
    error: unknown;
  }>;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/**
 * A function giving a valid access token (spec §7). It never signs in: accounts are made on the
 * sign-in screen.
 *
 * - A string: the stored session's token (supabase-js refreshes an expired one).
 * - null: no session is stored. The AI client treats that as "AI unavailable".
 * - Throws when reading the session failed (for instance an expired session whose refresh could
 *   not reach the network). The caller treats a throw as "try again later"; the next call retries.
 *
 * Concurrent calls share one session read, forgotten once it settles, success or failure.
 */
export function makeTokenSource(auth: AuthLike): () => Promise<string | null> {
  let inflight: Promise<string | null> | null = null;

  async function acquire(): Promise<string | null> {
    const { data, error } = await auth.getSession();
    if (error) throw asError(error, 'Could not read the session');
    return data.session ? data.session.access_token : null;
  }

  return () =>
    (inflight ??= acquire().finally(() => {
      inflight = null;
    }));
}

/** Whether a session is already stored, without ever signing in (for the allowance note). */
export function makeSessionCheck(auth: Pick<AuthLike, 'getSession'>): () => Promise<boolean> {
  return async () => {
    try {
      const { data, error } = await auth.getSession();
      return !error && data.session !== null;
    } catch {
      return false;
    }
  };
}
