// Browser side of the email alerts: after a team request or a direct expense is filed, nudge the server to send what
// the database just queued (src/app/api/alerts/flush/route.ts). Fire and forget: filing never waits on it or fails by it.
export function flushAlerts(): void {
  try {
    void fetch('/api/alerts/flush', { method: 'POST', keepalive: true }).catch(() => {});
  } catch {
    // never let an alert nudge break the form
  }
}
