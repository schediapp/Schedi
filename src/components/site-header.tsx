export function SiteHeader({ email }: { email?: string | null }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">Schedi</a>
      <nav>
        {email ? <span className="muted">{email}</span> : null}
        <a href="/portal">{email ? "Portal" : "Owner sign in"}</a>
      </nav>
    </header>
  );
}
