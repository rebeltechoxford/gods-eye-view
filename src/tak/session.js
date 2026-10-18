/** Revoke the HttpOnly operator session; no token/cookie value enters JS. */
export async function logoutOperatorSession(
  fetchImpl = globalThis.fetch,
  signal,
  { storageScope, canRevoke = () => true } = {},
) {
  if (!canRevoke())
    throw new Error(
      'Account changed; this page cannot sign out the new account',
    );
  if (
    storageScope !== undefined &&
    (typeof storageScope !== 'string' || !/^[a-f0-9]{64}$/.test(storageScope))
  )
    throw new Error('Invalid sign-out account scope');
  const response = await fetchImpl('/logout', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      'X-TAK-Session': '1',
      ...(storageScope ? { 'X-TAK-Storage-Scope': storageScope } : {}),
    },
  });
  if (!response.ok) {
    const error = new Error(
      'Server sign-out could not be confirmed. Local tactical data was cleared. Reopen while connected to sign in or try signing out again.',
    );
    error.accountChanged =
      response.status === 409 &&
      response.headers?.get('X-TAK-Account-Context') === 'mismatch';
    throw error;
  }
}

/** Clear the old page before sending; named scope binding protects a changed cookie. */
export async function signOutOperator({
  context,
  isCurrent,
  retire,
  navigate,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (!isCurrent()) {
    navigate('/');
    return;
  }
  const storageScope = context?.multiOperator
    ? context.storageScope
    : undefined;
  retire({ revokeOffline: true });
  try {
    await logoutOperatorSession(fetchImpl, signal, { storageScope });
  } catch (error) {
    if (error.accountChanged) {
      navigate('/');
      return;
    }
    throw error;
  }
  navigate('/login');
}
