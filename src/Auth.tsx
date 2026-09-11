import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  AudioLines,
  Eye,
  EyeOff,
  ShieldCheck,
} from "lucide-react";
import { api, post, Logo, Wave, Button, Notice, useAuth } from "./lib";
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: () => void;
    };
  }
}
function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (s: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false,
      id: string | undefined;
    const mount = () => {
      if (!cancelled && ref.current && window.turnstile)
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: onToken,
          "expired-callback": () => onToken(""),
          theme: "light",
        });
    };
    if (window.turnstile) mount();
    else {
      let script = document.querySelector<HTMLScriptElement>(
        "script[data-turnstile]",
      );
      if (!script) {
        script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.dataset.turnstile = "true";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", mount, { once: true });
    }
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey]);
  return <div ref={ref} className="turnstile" />;
}
export function AuthPage({ mode }: { mode: string }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [good, setGood] = useState(false);
  const [show, setShow] = useState(false);
  const [token, setToken] = useState("");
  const [config, setConfig] = useState<{
    turnstileSiteKey?: string;
    registrationEnabled?: boolean;
  }>({});
  useEffect(() => {
    setMessage("");
    api("/public/config")
      .then(setConfig)
      .catch(() => {});
  }, [mode]);
  const titles: Record<string, string> = {
    login: "Добре дошли отново.",
    register: "Вашият глас започва тук.",
    forgot: "Да върнем достъпа ви.",
    reset: "Ново начало. Нова парола.",
    verify: "Потвърдете вашия имейл.",
  };
  const descriptions: Record<string, string> = {
    login: "Вашите идеи и записи ви очакват.",
    register: "Създайте профил и опитайте с 1 000 безплатни символа.",
    forgot: "Ще ви изпратим линк за нова парола.",
    reset: "Изберете сигурна парола с поне 10 знака.",
    verify: "Една последна стъпка, преди да дадете глас на думите си.",
  };
  return (
    <main className="auth-layout">
      <aside className="auth-art">
        <Logo />
        <div>
          <span className="eyebrow">НАПИСАНО ОТ ВАС.</span>
          <h2>
            Историите
            <br />
            имат нужда
            <br />
            от глас.
          </h2>
          <p>Нека вашата бъде чута.</p>
          <div className="auth-wave">
            <AudioLines size={34} />
            <Wave bars={36} />
          </div>
        </div>
        <span>Текст. Глас. Възможности.</span>
      </aside>
      <section className="auth-main">
        <Link to="/" className="auth-back">
          <ArrowLeft size={17} />
          Към началото
        </Link>
        <div className="auth-form">
          <h1>{titles[mode]}</h1>
          <p>{descriptions[mode]}</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMessage("");
              setGood(false);
              const data = Object.fromEntries(new FormData(e.currentTarget));
              try {
                await post("/auth/" + mode, {
                  ...data,
                  acceptTerms: data.acceptTerms === "on",
                  token: params.get("token"),
                  turnstileToken: token,
                });
                setGood(true);
                if (mode === "login" || mode === "register") {
                  await refresh();
                  const plan = params.get("plan");
                  const next = params.get("next");
                  navigate(
                    plan && plan !== "free"
                      ? "/app/billing"
                      : next?.startsWith("/app") && !next.startsWith("//")
                        ? next
                        : "/app",
                  );
                } else if (mode === "verify") {
                  await refresh();
                  setMessage(
                    "Имейлът е потвърден. Вече можете да създавате аудио.",
                  );
                } else if (mode === "forgot")
                  setMessage(
                    "Ако има профил с този имейл, ще получите линк за нова парола.",
                  );
                else
                  setMessage(
                    "Паролата е променена. Влезте с новата си парола.",
                  );
              } catch (err) {
                setMessage((err as Error).message);
                window.turnstile?.reset();
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "register" && (
              <label>
                Вашето име
                <input
                  name="name"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder="Как да се обръщаме към вас?"
                />
              </label>
            )}
            {["login", "register", "forgot"].includes(mode) && (
              <label>
                Имейл адрес
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </label>
            )}
            {["login", "register", "reset"].includes(mode) && (
              <label>
                Парола
                <div className="password-field">
                  <input
                    name="password"
                    type={show ? "text" : "password"}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    minLength={10}
                    maxLength={128}
                    required
                    placeholder="Поне 10 знака"
                  />
                  <button
                    type="button"
                    aria-label={show ? "Скрий паролата" : "Покажи паролата"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            )}
            {mode === "login" && (
              <Link className="forgot-link" to="/forgot">
                Забравена парола?
              </Link>
            )}
            {mode === "register" && (
              <>
                <label className="check-label">
                  <input name="acceptTerms" type="checkbox" required />
                  <span>
                    Навършил/а съм 18 години и приемам{" "}
                    <Link to="/terms">общите условия</Link>. Запознах се с{" "}
                    <Link to="/privacy">политиката за поверителност</Link>.
                  </span>
                </label>
                {config.turnstileSiteKey && (
                  <Turnstile
                    siteKey={config.turnstileSiteKey}
                    onToken={setToken}
                  />
                )}
              </>
            )}
            {message && <Notice good={good}>{message}</Notice>}
            {!good || ["login", "register"].includes(mode) ? (
              <Button busy={busy} className="btn dark full" type="submit">
                {
                  (
                    {
                      login: "Влезте в профила",
                      register: "Създайте безплатен профил",
                      forgot: "Изпратете линк",
                      reset: "Запазете новата парола",
                      verify: "Потвърдете имейла",
                    } as Record<string, string>
                  )[mode]
                }
                <ArrowUpRight size={18} />
              </Button>
            ) : (
              <Link
                className="btn primary full"
                to={mode === "verify" ? "/app" : "/login"}
              >
                {mode === "verify" ? "Към студиото" : "Към входа"}
              </Link>
            )}
          </form>
          {mode === "login" && (
            <p className="auth-switch">
              Нямате профил?{" "}
              <Link
                to={
                  "/register" +
                  (params.get("next")
                    ? "?next=" + encodeURIComponent(params.get("next")!)
                    : "")
                }
              >
                Създайте безплатен
              </Link>
            </p>
          )}
          {mode === "register" && (
            <p className="auth-switch">
              Вече имате профил?{" "}
              <Link
                to={
                  "/login" +
                  (params.get("next")
                    ? "?next=" + encodeURIComponent(params.get("next")!)
                    : "")
                }
              >
                Влезте
              </Link>
            </p>
          )}
          <div className="auth-trust">
            <ShieldCheck size={15} />
            Вашите проекти са достъпни само за вас.
          </div>
        </div>
        <div className="auth-footer">
          <Link to="/privacy">Поверителност</Link>
          <Link to="/contact">Помощ</Link>
        </div>
      </section>
    </main>
  );
}
