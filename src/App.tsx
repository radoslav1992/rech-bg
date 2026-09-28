import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Routes,
  Route,
  Navigate,
  Outlet,
  NavLink,
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import {
  House,
  Film,
  AudioLines,
  Folder,
  Users,
  Settings,
  LogOut,
  Plus,
  Menu,
  X,
  CreditCard,
} from "lucide-react";
import {
  api,
  post,
  AuthContext,
  useAuth,
  Logo,
  number,
  type User,
} from "./lib";
import {
  PublicLayout,
  Landing,
  Pricing,
  Voices,
  About,
  Contact,
  Legal,
  NotFound,
} from "./Public";
import { JobActivity } from "./JobActivity";
import { pageMeta } from "../shared/seo";
// Public pages stay in the entry chunk; signed-in screens load on demand.
const AuthPage = lazy(() => import("./Auth").then(m => ({ default: m.AuthPage })));
const Dashboard = lazy(() => import("./Dashboard").then(m => ({ default: m.Dashboard })));
const Projects = lazy(() => import("./Dashboard").then(m => ({ default: m.Projects })));
const Studio = lazy(() => import("./Studio").then(m => ({ default: m.Studio })));
const SettingsPage = lazy(() => import("./Settings").then(m => ({ default: m.SettingsPage })));
const MediaTools = lazy(() => import("./MediaTools").then(m => ({default:m.MediaTools})));
const VideoStudio = lazy(() => import("./VideoStudio").then(m => ({ default: m.VideoStudio })));
const loading = <p className="loading-page" role="status">Зареждане…</p>;
/** Keeps the title and description current, and moves focus to the new page for screen readers. */
function RouteChange() {
  const { pathname } = useLocation();
  // Read through a ref: only a path change should re-run the effect (a query change must not scroll or refocus).
  const type = useNavigationType();
  const navigationType = useRef(type);
  navigationType.current = type;
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const meta = pageMeta(pathname);
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
    window.scrollTo(0, 0);
    const first = previous.current === undefined, sameScreen = previous.current === meta.route;
    previous.current = meta.route;
    // Skip the first load, URL replacements (e.g. a saved project getting its id) and changes within one screen,
    // so focus is never pulled out of an editor the user is working in.
    if (first || sameScreen || navigationType.current === "REPLACE") return;
    const target = document.querySelector<HTMLElement>("main h1") || document.querySelector<HTMLElement>("main");
    if (target) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  }, [pathname]);
  return null;
}
// A deploy replaces hashed chunks; reload once to fetch the new ones instead of showing a blank page.
window.addEventListener("vite:preloadError", (event) => {
  try {
    // At most one automatic reload per minute, so a genuinely missing chunk cannot loop.
    if (Date.now() - Number(sessionStorage.getItem("rech-chunk-reload") || 0) < 60_000) return;
    sessionStorage.setItem("rech-chunk-reload", String(Date.now()));
  } catch { /* Storage unavailable: still try one reload. */ }
  event.preventDefault();
  window.location.reload();
});
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Page failed to render", error); }
  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="loading-page" role="alert">
        <p>Страницата не успя да се зареди.</p>
        <button className="btn primary" onClick={() => window.location.reload()}>Презареди</button>
      </div>
    );
  }
}
function Boundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}><Suspense fallback={loading}>{children}</Suspense></ErrorBoundary>;
}
function Shell() {
  const { user, loading, failed, refresh } = useAuth();
  const [menu, setMenu] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => setMenu(false), [location.pathname]);
  if (loading)
    return (
      <div className="loading-page" role="status">Зареждане на вашето пространство…</div>
    );
  // A network error is not a sign-out: offer a retry instead of redirecting to the login page.
  if (!user && failed)
    return (
      <div className="loading-page" role="alert">
        <p>Няма връзка със сървъра.</p>
        <button className="btn primary" onClick={() => void refresh()}>Опитайте отново</button>
      </div>
    );
  if (!user)
    return (
      <Navigate
        to={
          "/login?next=" +
          encodeURIComponent(location.pathname + location.search)
        }
        replace
      />
    );
  const nav = [
    ["/app", "Начало", House],
    ["/app/studio", "Аудио", AudioLines],
    ["/app/video-studio", "Видео студио", Film],
    ["/app/media", "Медийни инструменти", Film],
    ["/app/projects", "Моите проекти", Folder],
    ["/app/voices", "Гласове", Users],
    ["/app/billing", "Абонамент", CreditCard],
    ["/app/settings", "Настройки", Settings],
  ] as const;
  return (
    <div className="app-shell">
      <header className="mobile-app">
        <Logo />
        <button
          className="round"
          aria-label="Меню"
          aria-expanded={menu}
          aria-controls="app-sidebar"
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </button>
      </header>
      <aside id="app-sidebar" className={"sidebar " + (menu ? "open" : "")}>
        <Logo />
        <Link className="btn primary new-project" to="/app/studio">
          <Plus size={18} />
          Нов запис
        </Link>
        <span className="nav-label">ВАШЕТО ПРОСТРАНСТВО</span>
        <nav>
          {nav.map(([to, label, Icon]) => (
            <NavLink end={to === "/app"} key={to} to={to}>
              <Icon size={19} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="quota">
            <div>
              <strong>{number(Math.max(0, user.limit - user.used))}</strong>
              <span>кредита остават</span>
            </div>
            <progress max={user.limit} value={user.used} />
            <Link to="/app/billing">
              Вижте плановете <span>↗</span>
            </Link>
          </div>
          <Link className="user-profile" to="/app/settings">
            <span className="user-avatar">{user.name[0]}</span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </div>
          </Link>
          <button
            className="logout"
            onClick={async () => {
              await post("/auth/logout");
              await refresh();
              navigate("/");
            }}
          >
            <LogOut size={16} />
            Изход
          </button>
        </div>
      </aside>
      <main className="workspace">
        {!user.verified && (
          <div className="verify-banner">
            Потвърдете имейла си, за да създавате аудио.{" "}
            <Link to="/app/settings">Изпрати ново писмо</Link>
          </div>
        )}
        <JobActivity key={user.id}><Boundary><Outlet /></Boundary></JobActivity>
      </main>
    </div>
  );
}
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const refresh = async () => {
    try {
      const d = await api<{ user: User | null }>("/auth/me");
      setUser(d.user);
      setFailed(false);
    } catch {
      // Keep the current user on a transient failure; only an explicit null response signs out.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <AuthContext.Provider value={{ user, loading, failed, refresh }}>
      <RouteChange />
      <Boundary>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route
            path="/"
            element={user ? <Navigate to="/app" replace /> : <Landing />}
          />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/voices" element={<Voices />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          {["terms", "privacy", "cookies", "refunds"].map((page) => (
            <Route
              key={page}
              path={"/" + page}
              element={<Legal page={page} />}
            />
          ))}
        </Route>
        {["login", "register", "forgot", "reset", "verify"].map((mode) => (
          <Route
            key={mode}
            path={"/" + mode}
            element={<AuthPage mode={mode} />}
          />
        ))}
        <Route path="/app" element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="studio" element={<Studio />} />
          <Route path="studio/:id" element={<Studio />} />
          <Route path="video-studio" element={<VideoStudio />} />
          <Route path="video-studio/:id" element={<VideoStudio />} />
          <Route path="media" element={<MediaTools />} />
          <Route path="projects" element={<Projects />} />
          <Route path="voices" element={<Voices inApp />} />
          <Route path="billing" element={<Pricing inApp />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Boundary>
    </AuthContext.Provider>
  );
}
