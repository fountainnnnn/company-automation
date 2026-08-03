import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { PageTitleProvider } from "../lib/pageTitle";
import type { PageTitleState } from "../lib/pageTitle";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useMediaQuery } from "../lib/useMediaQuery";
import {
  Bell,
  ClipboardList,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Search,
  Settings,
  Settings2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SkeletonList } from "./Skeleton";
import type { OverviewStats } from "../lib/types";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
  /** "flags" and "pending" carry a live count pill when there is one. */
  badge?: "flags" | "pending";
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
      { to: "/timesheets", label: "Timesheets", icon: ClipboardList, end: false },
      { to: "/search", label: "Search", icon: Search, end: false },
    ],
  },
  {
    label: "Operations",
    adminOnly: true,
    items: [
      { to: "/attendance", label: "Attendance", icon: MapPin, end: false, badge: "flags" },
      { to: "/workers", label: "Workers", icon: Users, end: false, badge: "pending" },
      { to: "/projects-admin", label: "Manage", icon: Settings2, end: false },
    ],
  },
];

/** Route → page name, so the topbar heading always matches the nav label. */
const ROUTE_TITLES: Array<[string, string]> = [
  ["/projects-admin", "Manage"],
  ["/projects", "Projects"],
  ["/timesheets", "Timesheets"],
  ["/search", "Search"],
  ["/attendance", "Attendance"],
  ["/workers", "Workers"],
  ["/settings", "Settings"],
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
  const [counts, setCounts] = useState<{ flags: number; pending: number }>({
    flags: 0,
    pending: 0,
  });
  const [term, setTerm] = useState("");

  const open = compact && drawer;
  const title =
    pageTitle && pageTitle.path === location.pathname
      ? pageTitle.title
      : routeTitle(location.pathname);
  const name = profile?.full_name ?? "Signed in";
  const groups = useMemo(() => GROUPS.filter((g) => isAdmin || !g.adminOnly), [isAdmin]);

  // One aggregate call feeds both sidebar count pills; staff never see the rows.
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    void (async () => {
      const { data } = await supabase.rpc("overview_stats");
      const row = (data as OverviewStats[] | null)?.[0];
      if (!active || !row) return;
      setCounts({ flags: Number(row.open_flags), pending: Number(row.pending_workers) });
    })();
    return () => {
      active = false;
    };
  }, [isAdmin, location.pathname]);

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

  function badgeFor(item: NavItem): number {
    if (item.badge === "flags") return counts.flags;
    if (item.badge === "pending") return counts.pending;
    return 0;
  }

  return (
    <>
      <div className="orb" aria-hidden="true" />
      <div className={`app${compact ? " compact" : ""}`}>
        {open && (
          <div className="scrim" onMouseDown={() => setDrawer(false)} aria-hidden="true" />
        )}

        <aside
          id="sidebar"
          className={`sidebar${open ? " open" : ""}`}
          ref={panelRef}
          {...(open ? { role: "dialog" as const, "aria-modal": true, "aria-label": "Navigation" } : {})}
        >
          <div className="side-brand">
            <span className="side-mark" aria-hidden="true">
              CL
            </span>
            <span className="side-brand-text">
              <span className="side-brand-name truncate">CL Automation</span>
              <span className="side-brand-sub">Site records</span>
            </span>
          </div>

          <nav className="side-nav" aria-label="Main">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="side-section">{group.label}</p>
                <div className="side-links">
                  {group.items.map((l) => {
                    const count = badgeFor(l);
                    const Icon = l.icon;
                    return (
                      <NavLink key={l.to} to={l.to} end={l.end} className="side-link">
                        <Icon className="nav-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                        <span className="truncate">{l.label}</span>
                        {count > 0 && (
                          <span
                            className={`side-badge${l.badge === "pending" ? " warn" : ""}`}
                            title={
                              l.badge === "pending"
                                ? `${count} pending registrations`
                                : `${count} open flags`
                            }
                          >
                            {count}
                          </span>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="side-spacer" />

          <div className="side-foot">
            {isAdmin && (
              <NavLink to="/settings" className="side-link">
                <Settings className="nav-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate">Settings</span>
              </NavLink>
            )}
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

            <h1 className="truncate" title={title}>
              {title}
            </h1>

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
              {isAdmin && (
                <NavLink
                  to="/attendance"
                  className="icon-btn round"
                  aria-label={
                    counts.flags > 0
                      ? `Attendance flags — ${counts.flags} open`
                      : "Attendance flags"
                  }
                  title={
                    counts.flags > 0
                      ? `${counts.flags} attendance flags open`
                      : "No attendance flags open"
                  }
                >
                  <Bell size={18} strokeWidth={1.75} aria-hidden="true" />
                </NavLink>
              )}
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
