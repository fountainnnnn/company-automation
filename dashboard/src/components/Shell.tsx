import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { PageTitleProvider } from "../lib/pageTitle";
import type { PageTitleState } from "../lib/pageTitle";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useMediaQuery } from "../lib/useMediaQuery";
import {
  CalendarDays,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Send,
  Settings2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SkeletonList } from "./Skeleton";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  adminOnly: boolean;
}

const GROUPS: NavGroup[] = [
  {
    label: "Main",
    adminOnly: false,
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/projects", label: "Projects", icon: FolderOpen, end: false },
      { to: "/search", label: "Search", icon: Search, end: false },
    ],
  },
  {
    label: "Operations",
    adminOnly: true,
    items: [
      { to: "/workers", label: "Workers", icon: Users, end: false },
      { to: "/projects-admin", label: "Manage", icon: Settings2, end: false },
    ],
  },
];

/** Route → page name, so the topbar heading always matches the nav label. */
const ROUTE_TITLES: Array<[string, string]> = [
  ["/projects-admin", "Manage"],
  ["/projects", "Projects"],
  ["/search", "Search"],
  ["/workers", "Workers"],
];

function routeTitle(pathname: string): string {
  const hit = ROUTE_TITLES.find(([prefix]) => pathname.startsWith(prefix));
  return hit ? hit[1] : "Overview";
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The sidebar becomes an overlay drawer below this width — same value as the CSS. */
const COMPACT = "(max-width: 899px)";

export function Shell() {
  const { profile, isAdmin, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT);
  const panelRef = useRef<HTMLElement>(null);
  const [drawer, setDrawer] = useState(false);
  const [pageTitle, setPageTitle] = useState<PageTitleState | null>(null);
  const [term, setTerm] = useState("");

  const open = compact && drawer;
  const title =
    pageTitle && pageTitle.path === location.pathname
      ? pageTitle.title
      : routeTitle(location.pathname);
  const name = profile?.full_name ?? "Signed in";
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());
  const groups = useMemo(() => GROUPS.filter((g) => isAdmin || !g.adminOnly), [isAdmin]);

  // A drawer that survived a navigation would cover the page it just opened.
  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawer(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="orb" aria-hidden="true" />
      <div className={`app${compact ? " compact" : ""}${location.pathname === "/" ? " overview-route" : ""}`}>
        {open && (
          <div className="scrim" onMouseDown={() => setDrawer(false)} aria-hidden="true" />
        )}

        <aside
          id="sidebar"
          className={`sidebar${open ? " open" : ""}`}
          ref={panelRef}
          {...(open ? { role: "dialog" as const, "aria-modal": true, "aria-label": "Navigation" } : {})}
        >
          <div className="sidebar-inner">
          <div className="side-brand">
            <span className="side-mark" aria-hidden="true">
              CL
            </span>
            <span className="side-brand-text">
              <span className="side-brand-name truncate">Site Command</span>
              <span className="side-brand-sub">CL Automation</span>
            </span>
          </div>

          <nav className="side-nav" aria-label="Main">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="side-section">{group.label}</p>
                <div className="side-links">
                  {group.items.map((l) => {
                    const Icon = l.icon;
                    return (
                      <NavLink key={l.to} to={l.to} end={l.end} className="side-link">
                        <Icon className="nav-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                        <span className="truncate">{l.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="side-spacer" />

          <div className="side-source">
            <span className="side-source-label">Data source</span>
            <div>
              <span className="side-source-icon" aria-hidden="true">
                <Send size={17} strokeWidth={1.7} />
              </span>
              <span>
                <strong>Telegram</strong>
                <small>Connected</small>
              </span>
            </div>
          </div>

          <div className="side-foot">
            <button className="side-link" type="button" onClick={() => void signOut()}>
              <LogOut className="nav-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">Sign out</span>
            </button>
          </div>

          <div className="side-user">
            <span className="avatar" aria-hidden="true">
              {initialsOf(name)}
            </span>
            <span className="side-user-text">
              <span className="name truncate" title={name}>
                {name}
              </span>
              <span className="role">{profile?.role ?? "staff"}</span>
            </span>
          </div>
          </div>
        </aside>

        <div className="app-main">
          <header className="topbar">
            {compact && (
              <button
                className="hamburger"
                aria-label="Open navigation"
                aria-expanded={open}
                aria-controls="sidebar"
                onClick={() => setDrawer(true)}
              >
                <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}

            <div className="topbar-context">
              <span className="topbar-date">
                Today is <strong>{today}</strong>
                <CalendarDays size={16} strokeWidth={1.7} aria-hidden="true" />
              </span>
            </div>
            <h1 className="topbar-title truncate" title={title}>{title}</h1>

            <form
              className="topbar-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                const q = term.trim();
                navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
              }}
            >
              <Search size={18} strokeWidth={1.75} aria-hidden="true" />
              <label className="sr-only" htmlFor="topbar-q">
                Search reports
              </label>
              <input
                id="topbar-q"
                type="search"
                placeholder="Search reports…"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
            </form>

            <div className="topbar-actions">
              <span className="user-chip">
                <span className="avatar" aria-hidden="true">
                  {initialsOf(name)}
                </span>
                <span className="name truncate" title={name}>
                  {name}
                </span>
              </span>
            </div>
          </header>

          <main className="page">
            <PageTitleProvider onTitle={setPageTitle}>
              <Suspense fallback={<SkeletonList rows={3} />}>
                <Outlet />
              </Suspense>
            </PageTitleProvider>
          </main>
        </div>
      </div>
    </>
  );
}
