/** Missing optional data is handled by onboarding; it is not a broken app asset. */
export function optionalSnapshot(value: string): boolean {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "templehao.github.io"].includes(url.hostname)
      && /^\/(?:codex\/)?(?:blog-sync|weread-sync|weread-sync-status)\.json$/.test(url.pathname);
  } catch { return false; }
}
