import Link from "next/link";
import type { Route } from "next";

type SecondaryPage = "home" | "privacy" | "start";

const secondaryNavItems: Array<{
  id: SecondaryPage | "signin";
  href: Route;
  label: string;
  variant?: "primary";
}> = [
  { id: "home", href: "/" as Route, label: "Home" },
  { id: "privacy", href: "/privacy" as Route, label: "Privacy" },
  { id: "start", href: "/get-started" as Route, label: "Start", variant: "primary" },
];

export function KeepsLogoLink() {
  return (
    <Link aria-label="Keeps home" className="keeps-logo" href={"/" as Route}>
      <svg
        aria-hidden="true"
        fill="none"
        height="28"
        viewBox="0 0 34 28"
        width="34"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M17 2.75L29.75 9.25L17 15.75L4.25 9.25L17 2.75Z"
          className="keeps-logo-layer keeps-logo-layer-top"
        />
        <path
          d="M7.5 13.25L17 18.1L26.5 13.25"
          className="keeps-logo-layer keeps-logo-layer-mid"
        />
        <path
          d="M7.5 18.25L17 23.1L26.5 18.25"
          className="keeps-logo-layer keeps-logo-layer-bottom"
        />
      </svg>
      <span>Keeps</span>
    </Link>
  );
}

export function SecondaryHeader({ active }: { active?: SecondaryPage }) {
  return (
    <header className="keeps-header keeps-secondary-header">
      <div className="keeps-side" />
      <nav className="keeps-nav keeps-secondary-nav" aria-label="Main navigation">
        <KeepsLogoLink />
        <div className="keeps-secondary-nav-links">
          {secondaryNavItems.map((item) => (
            <Link
              aria-current={active === item.id ? "page" : undefined}
              className={[
                active === item.id ? "is-active" : "",
                item.variant === "primary" ? "is-primary" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              href={item.href}
              key={item.id}
            >
              {item.label}
            </Link>
          ))}
          <Link className="is-muted" href={"/sign-in" as Route}>
            Sign in
          </Link>
        </div>
      </nav>
      <div className="keeps-side" />
    </header>
  );
}

export function SecondaryFooter() {
  return (
    <footer className="keeps-footer keeps-secondary-footer">
      <div className="keeps-side" />
      <div className="keeps-footer-inner keeps-secondary-footer-inner">
        <KeepsLogoLink />
        <div className="keeps-secondary-footer-links">
          <Link href={"/privacy" as Route}>Privacy</Link>
          <Link href={"/get-started" as Route}>Start</Link>
        </div>
      </div>
      <div className="keeps-side" />
    </footer>
  );
}
