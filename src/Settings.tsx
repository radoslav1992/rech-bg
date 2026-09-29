import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Download,
  Mail,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { voiceList, sampleSentence } from "../shared/catalog";
import { api, post, Button, Notice, useAuth, type Voice } from "./lib";
// Admin-only panels load only for admins.
const AvatarLibraryAdmin = lazy(() => import("./AvatarLibrary").then(m => ({ default: m.AvatarLibraryAdmin })));
const StudioVoiceAdmin = lazy(() => import("./StudioVoiceAdmin").then(m => ({ default: m.StudioVoiceAdmin })));
export function SettingsPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [good, setGood] = useState(false);
  const action = async (
    key: string,
    fn: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(key);
    setMessage("");
    try {
      await fn();
      setMessage(success);
      setGood(true);
    } catch (e) {
      setMessage((e as Error).message);
      setGood(false);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="app-page settings-page">
      <div className="page-heading">
        <h1>Настройки</h1>
        <p>Вашият профил, сигурност и лични данни.</p>
      </div>
      {message && <Notice good={good} error={!good}>{message}</Notice>}
      <section className="settings-card">
        <h2>
          <UserRound size={21} />
          Лични данни
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const d = Object.fromEntries(new FormData(e.currentTarget));
            void action(
              "profile",
              async () => {
                await api("/settings", {
                  method: "PUT",
                  body: JSON.stringify(d),
                });
                await refresh();
              },
              "Профилът е обновен.",
            );
          }}
        >
          <label>
            Име
            <input
              name="name"
              defaultValue={user?.name}
              required
              minLength={2}
              maxLength={80}
            />
          </label>
          <label>
            Имейл
            <input value={user?.email || ""} readOnly />
          </label>
          <div className="email-status">
            {user?.verified ? (
              <span>
                <Check size={15} />
                Потвърден имейл
              </span>
            ) : (
              <Button
                busy={busy === "verify"}
                onClick={() =>
                  action(
                    "verify",
                    () => post("/auth/resend"),
                    "Изпратихме ново писмо за потвърждение.",
                  )
                }
                type="button"
                className="text-link"
              >
                Изпратете писмо за потвърждение
              </Button>
            )}
          </div>
          <Button busy={busy === "profile"} type="submit" className="btn dark">
            Запазете промените
          </Button>
        </form>
      </section>
      <section className="settings-card">
        <h2>
          <ShieldCheck size={21} />
          Сигурност
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = Object.fromEntries(new FormData(form));
            void action(
              "password",
              async () => {
                await post("/settings/password", data);
                form.reset();
              },
              "Паролата е променена. Другите сесии са прекратени.",
            );
          }}
        >
          <label>
            Текуща парола
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <label>
            Нова парола
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={128}
            />
          </label>
          <p className="small-note">
            Поне 10 знака. Промяната ще прекрати достъпа от другите ви
            устройства.
          </p>
          <Button
            type="submit"
            busy={busy === "password"}
            className="btn outline"
          >
            Променете паролата
          </Button>
        </form>
      </section>
      <section className="settings-card">
        <h2>
          <Download size={21} />
          Вашите данни
        </h2>
        <p>
          Изтеглете профила, проектите и историята си в JSON формат. Аудио
          файловете се изтеглят от съответния проект.
        </p>
        <a className="btn outline" href="/api/settings/export">
          <Download size={17} />
          Изтеглете данните
        </a>
      </section>
      {user?.admin && <Suspense fallback={<p role="status">Зареждане…</p>}><BillingHealth /><AvatarLibraryAdmin /><StudioVoiceAdmin /><AdminSettings /></Suspense>}
      <section className="settings-card danger-zone">
        <h2>
          <Trash2 size={21} />
          Изтриване на профила
        </h2>
        <p>
          Това премахва профила, всички проекти и записи. Действието е
          необратимо. Активният абонамент трябва първо да бъде прекратен и
          платеният период да е приключил.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const password = new FormData(e.currentTarget).get("password");
            if (
              !confirm(
                "Сигурни ли сте? Всички проекти и записи ще бъдат изтрити окончателно.",
              )
            )
              return;
            void action(
              "delete",
              async () => {
                await api("/settings/account", {
                  method: "DELETE",
                  body: JSON.stringify({ password }),
                });
                await refresh();
                navigate("/");
              },
              "",
            );
          }}
        >
          <label>
            Потвърдете с паролата си
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              maxLength={128}
            />
          </label>
          <Button className="btn danger" type="submit" busy={busy === "delete"}>
            Изтрийте профила
          </Button>
        </form>
      </section>
    </div>
  );
}
function AdminSettings() {
  const [voices, setVoices] = useState<Voice[]>(voiceList);
  const [messages, setMessages] = useState<any[]>([]);
  const [selected, setSelected] = useState("mila");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<{ voice: string; audio: Blob } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!draft) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(draft.audio);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);
  const generateSample = async () => {
    setBusy(true);
    setStatus("Създаваме примера. Това може да отнеме около минута.");
    try {
      const response = await fetch(`/api/admin/voices/${selected}/sample/generate`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || "Примерът не беше създаден. Опитайте отново.");
      }
      setDraft({ voice: selected, audio: await response.blob() });
      setStatus("Примерът е готов. Прослушайте го и го публикувайте, когато сте доволни.");
    } catch (err) {
      setStatus((err as Error).message);
    } finally { setBusy(false); }
  };
  const publishSample = async () => {
    if (!draft || draft.voice !== selected) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", draft.audio, `${draft.voice}.wav`);
      await api(`/admin/voices/${draft.voice}/sample`, { method: "POST", body });
      setDraft(null);
      setStatus("Аудио примерът е публикуван.");
      load();
    } catch (err) {
      setStatus((err as Error).message);
    } finally { setBusy(false); }
  };
  const load = () => {
    api("/voices")
      .then((d) => setVoices(d.voices))
      .catch(() => {});
    api("/admin/messages")
      .then((d) => setMessages(d.messages))
      .catch((e) => setStatus(e.message));
  };
  useEffect(load, []);
  return (
    <>
      <section className="settings-card">
        <h2>
          <Upload size={21} />
          Примери на гласовете
        </h2>
        <p>
          Изберете глас и създайте пример с текста по-долу. Прослушайте го,
          след което го публикувайте в каталога и студиото. Създаването използва
          платеното потребление на услугата, без да отнема кредити от личния ви план.
        </p>
        <blockquote>{sampleSentence}</blockquote>
        {status && <Notice>{status}</Notice>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            setBusy(true);
            try {
              await api("/admin/voices/" + selected + "/sample", {
                method: "POST",
                body: new FormData(form),
              });
              setStatus("Аудио примерът е публикуван.");
              setDraft(null);
              load();
              form.reset();
            } catch (err) {
              setStatus((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Глас
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => { setSelected(e.target.value); setDraft(null); setStatus(""); }}
            >
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.sampleUrl ? " — има пример" : " — без пример"}
                </option>
              ))}
            </select>
          </label>
          <Button busy={busy} className="btn dark" type="button" onClick={generateSample}>
            <Sparkles size={17} />
            Създай пример
          </Button>
          {draft?.voice === selected && previewUrl && (
            <div className="sample-admin-player">
              <span>Нов пример — още не е публикуван</span>
              <audio controls src={previewUrl} />
              <Button busy={busy} className="btn dark" type="button" onClick={publishSample}>
                {voices.find((v) => v.id === selected)?.sampleUrl ? "Замени публикувания пример" : "Публикувай примера"}
              </Button>
            </div>
          )}
          <label>
            Или качете свой WAV / MP3 файл до 2 MB
            <input
              name="file"
              type="file"
              required
              disabled={busy}
              accept="audio/wav,audio/mpeg,.wav,.mp3"
            />
          </label>
          <Button busy={busy} className="btn dark" type="submit">
            <Upload size={17} />
            Качете примера
          </Button>
        </form>
        {voices.find((v) => v.id === selected)?.sampleUrl && (
          <div className="sample-admin-player">
            <audio
              controls
              src={voices.find((v) => v.id === selected)?.sampleUrl}
            />
            <button
              className="text-link"
              disabled={busy}
              onClick={async () => {
                if (!confirm("Да премахнем ли примера?")) return;
                try {
                  await api("/admin/voices/" + selected + "/sample", {
                    method: "DELETE",
                  });
                  load();
                  setStatus("Примерът е премахнат.");
                } catch (e) {
                  setStatus((e as Error).message);
                }
              }}
            >
              Премахнете примера
            </button>
          </div>
        )}
      </section>
      <section className="settings-card">
        <h2>
          <Mail size={21} />
          Запитвания от сайта
        </h2>
        {messages.length ? (
          messages.map((m) => (
            <article className="contact-message" key={m.id}>
              <strong>{m.name}</strong>
              <a href={"mailto:" + m.email}>{m.email}</a>
              <small>
                {new Date(m.created_at * 1000).toLocaleString("bg")}
              </small>
              <p>{m.message}</p>
            </article>
          ))
        ) : (
          <p>Все още няма запитвания.</p>
        )}
      </section>
    </>
  );
}

/** Administrators: are Stripe webhooks arriving? A missing or stale "last event" points at the webhook setup. */
function BillingHealth() {
  const [health, setHealth] = useState<{ lastEvent: number | null; eventsLastWeek: number; activeSubscriptions: number; webhookSecret: boolean; prices: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api("/admin/billing-health").then(setHealth).catch((e) => setError(e.message)); }, []);
  return (
    <section className="settings-card">
      <h2>Плащания · webhook от Stripe</h2>
      {error && <Notice error>{error}</Notice>}
      {health && <>
        <p>
          Последно получено събитие: <strong>{health.lastEvent ? new Date(health.lastEvent * 1000).toLocaleString("bg") : "никога"}</strong> ·
          за последните 7 дни: <strong>{health.eventsLastWeek}</strong> · активни абонаменти: <strong>{health.activeSubscriptions}</strong>
        </p>
        {!health.webhookSecret && <Notice error>Липсва STRIPE_WEBHOOK_SECRET — събитията от Stripe се отхвърлят.</Notice>}
        {!health.prices && <Notice error>Липсва някоя от STRIPE_PRICE_STARTER / CREATOR / STUDIO.</Notice>}
        <p className="small-note">Ако след плащане или смяна на план тук няма ново събитие, проверете в Stripe → Developers → Webhooks адреса https://rechbg.com/api/billing/webhook, режима (test/live), избраните събития и секрета. Приложението допълнително чете абонамента от Stripe при отваряне на „Абонамент“ и веднъж на сесия.</p>
      </>}
    </section>
  );
}
