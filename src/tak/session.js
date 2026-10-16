/** Revoke the HttpOnly operator session; no token/cookie value enters JS. */
export async function logoutOperatorSession(
  fetchImpl = globalThis.fetch,
  signal,
) {
  const response = await fetchImpl('/logout', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'X-TAK-Session': '1' },
  });
  if (!response.ok)
    throw new Error(
      'Server sign-out could not be confirmed. Local tactical data was cleared; retry while connected.',
    );
}
