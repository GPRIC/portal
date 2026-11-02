export default function SetupPage() {
  return (
    <main className="auth">
      <div className="authbrand"><span className="dotb" />GPRIC Board</div>
      <h1>Portal Not Connected Yet</h1>
      <p>This copy of the portal has no database settings. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the Vercel project settings (or in .env.local on a developer machine), then deploy again.</p>
    </main>
  );
}
