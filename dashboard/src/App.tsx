import { lazy } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { ToastProvider } from "./components/Toast";
import { Shell } from "./components/Shell";
import { LoginPage } from "./pages/Login";

// Route-level code splitting — admin views never ship to staff sessions.
const OverviewPage = lazy(() =>
  import("./pages/Overview").then((m) => ({ default: m.OverviewPage })),
);
const ProjectsPage = lazy(() =>
  import("./pages/Projects").then((m) => ({ default: m.ProjectsPage })),
);
const GalleryPage = lazy(() =>
  import("./pages/Gallery").then((m) => ({ default: m.GalleryPage })),
);
const TimesheetsPage = lazy(() =>
  import("./pages/Timesheets").then((m) => ({ default: m.TimesheetsPage })),
);
const SearchPage = lazy(() => import("./pages/Search").then((m) => ({ default: m.SearchPage })));
const AttendancePage = lazy(() =>
  import("./pages/Attendance").then((m) => ({ default: m.AttendancePage })),
);
const PayrollPage = lazy(() =>
  import("./pages/Payroll").then((m) => ({ default: m.PayrollPage })),
);
const WorkersPage = lazy(() =>
  import("./pages/Workers").then((m) => ({ default: m.WorkersPage })),
);
const ProjectsAdminPage = lazy(() =>
  import("./pages/ProjectsAdmin").then((m) => ({ default: m.ProjectsAdminPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.SettingsPage })),
);

function Booting() {
  return (
    <>
      <div className="orb" aria-hidden="true" />
      <div className="login-wrap">
        <p className="muted">Loading…</p>
      </div>
    </>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Booting />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { profile, loading } = useAuth();
  if (loading) return <Booting />;
  if (profile?.role !== "admin") return <AdminGate />;
  return <>{children}</>;
}

/** Staff hitting an admin URL get an explanation, not a silent bounce. */
function AdminGate() {
  return (
    <div className="admin-gate reveal">
      <span className="lock" aria-hidden="true">
        🔒
      </span>
      <h2>Admin access required</h2>
      <p>
        You're signed in as staff, so this area is off limits — attendance,
        worker approvals and settings are admin-only. Ask an administrator if
        you need something from here.
      </p>
      <Link className="btn btn-primary" to="/projects">
        Back to projects
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/:id" element={<GalleryPage />} />
              <Route path="timesheets" element={<TimesheetsPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route
                path="attendance"
                element={
                  <RequireAdmin>
                    <AttendancePage />
                  </RequireAdmin>
                }
              />
              <Route
                path="payroll"
                element={
                  <RequireAdmin>
                    <PayrollPage />
                  </RequireAdmin>
                }
              />
              <Route
                path="workers"
                element={
                  <RequireAdmin>
                    <WorkersPage />
                  </RequireAdmin>
                }
              />
              <Route
                path="projects-admin"
                element={
                  <RequireAdmin>
                    <ProjectsAdminPage />
                  </RequireAdmin>
                }
              />
              <Route
                path="settings"
                element={
                  <RequireAdmin>
                    <SettingsPage />
                  </RequireAdmin>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
