import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./Button";
import { SkeletonList } from "./Skeleton";

const STAFF_LINKS = [
  { to: "/", label: "Projects", end: true },
  { to: "/search", label: "Search", end: false },
];

const ADMIN_LINKS = [
  { to: "/", label: "Projects", end: true },
  { to: "/search", label: "Search", end: false },
  { to: "/attendance", label: "Attendance", end: false },
  { to: "/workers", label: "Workers", end: false },
  { to: "/projects-admin", label: "Manage", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export function Shell() {
  const { profile, isAdmin, signOut } = useAuth();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  const links = isAdmin ? ADMIN_LINKS : STAFF_LINKS;

  useLayoutEffect(() => {
    function measure() {
      const nav = navRef.current;
      const active = nav?.querySelector<HTMLElement>("a.active");
      if (!nav || !active) {
        setPill(null);
        return;
      }
      setPill({ left: active.offsetLeft, width: active.offsetWidth });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [location.pathname, links.length]);

  return (
    <>
      <div className="orb" aria-hidden="true" />
      <div className="app">
        <header className="topbar">
          <span className="brand">
            <span className="brand-dot" aria-hidden="true" />
            CL Automation
          </span>

          <nav className="nav" ref={navRef} aria-label="Main">
            {pill && (
              <span
                className="nav-pill"
                aria-hidden="true"
                style={{ transform: `translateX(${pill.left}px)`, width: pill.width }}
              />
            )}
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end}>
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="user-chip">
            <span className="name truncate" title={profile?.full_name ?? ""}>
              {profile?.full_name ?? "Signed in"}
            </span>
            <span className={`role-badge ${isAdmin ? "admin" : ""}`}>
              {profile?.role ?? "staff"}
            </span>
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="page">
          <Suspense fallback={<SkeletonList rows={3} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </>
  );
}
