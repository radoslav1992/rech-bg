import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  Headphones,
  Menu,
  Mic2,
  Play,
  Podcast,
  ShieldCheck,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { plans, voiceList, modes } from "../shared/catalog";
import {
  Logo,
  Wave,
  VoiceCard,
  api,
  post,
  useAuth,
  Button,
  Notice,
  type Voice,
} from "./lib";
export function PublicLayout() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  return (
    <>
      <header className="public-header">
        <div className="container header-inner">
          <Logo />
          <nav className={open ? "open" : ""} aria-label="Основно меню">
            {[
              ["/", "Начало"],
              ["/voices", "Гласове"],
              ["/pricing", "Цени"],
              ["/about", "За нас"],
            ].map(([to, t]) => (
              <NavLink key={to} to={to} onClick={() => setOpen(false)}>
                {t}
              </NavLink>
            ))}
          </nav>
          <div className="header-actions">
            <Link className="login-link" to={user ? "/app" : "/login"}>
              {user ? "Табло" : "Вход"}
            </Link>
            <Link
              className="btn dark small-btn"
              to={user ? "/app/studio" : "/register"}
            >
              {user ? "Към студиото" : "Опитайте безплатно"}
              <ArrowUpRight size={16} />
            </Link>
            <button
              className="mobile-menu round"
              onClick={() => setOpen(!open)}
              aria-label="Меню"
            >
              {open ? <X /> : <Menu />}
            </button>
          </div>
        </div>
      </header>
      <Outlet />
      <footer className="footer">
        <div className="container">
          <div className="footer-top">
            <div>
              <Logo />
              <p>
                Думите са ваши.
                <br />
                Ние им даваме глас.
              </p>
            </div>
            <div>
              <strong>Създавайте</strong>
              <Link to="/app/studio">Текст в реч</Link>
              <Link to="/app/studio?mode=podcast">Подкасти</Link>
              <Link to="/voices">Всички гласове</Link>
            </div>
            <div>
              <strong>Реч БГ</strong>
              <Link to="/pricing">Цени</Link>
              <Link to="/about">За нас</Link>
              <Link to="/contact">Контакт</Link>
            </div>
            <div>
              <strong>Полезно</strong>
              <Link to="/terms">Общи условия</Link>
              <Link to="/privacy">Поверителност</Link>
              <Link to="/cookies">Бисквитки</Link>
              <Link to="/refunds">Отказ и възстановяване</Link>
            </div>
          </div>
          <div className="footer-bottom">
            <span>
              © {new Date().getFullYear()} Реч БГ. Създадено за българския език.
            </span>
            <span className="bg-flag">
              <i /> На вашия език.
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
function StudioPreview() {
  return (
    <div className="studio-preview">
      <div className="preview-top">
        <div>
          <AudioLines size={18} />
          <strong>Вашето аудио студио</strong>
        </div>
        <span className="preview-tag">ПРЕГЛЕД</span>
      </div>
      <div className="preview-tabs">
        <span className="active">
          <FileText size={15} />
          Текст в реч
        </span>
        <span>
          <Podcast size={15} />
          Подкаст
        </span>
        <span>
          <Video size={15} />
          Озвучаване
        </span>
      </div>
      <div className="preview-content">
        <span className="micro">ТЕКСТЪТ ВИ</span>
        <p>
          Някои думи просто трябва
          <br />
          да бъдат чути.
        </p>
        <p className="preview-secondary">
          Превърнете следващата си идея в глас,
          <br />
          който хората ще запомнят.
        </p>
        <div className="preview-caret" />
        <span className="preview-count">Вашата история започва тук.</span>
      </div>
      <div className="preview-voice">
        <span className="voice-avatar Корал">М</span>
        <div>
          <strong>Мила</strong>
          <small>Ясен и свеж глас</small>
        </div>
        <ChevronDown size={16} />
        <Link to="/register" className="btn dark">
          <Sparkles size={16} />
          Създай аудио
        </Link>
      </div>
      <div className="preview-audio">
        <span className="round decorative">
          <AudioLines size={20} />
        </span>
        <Wave small bars={55} />
        <span>WAV</span>
      </div>
      <div className="preview-caption">
        Илюстрация на студиото · чуйте гласовете в каталога
      </div>
    </div>
  );
}
export function Landing() {
  const [voices, setVoices] = useState<Voice[]>(voiceList);
  useEffect(() => {
    api<{ voices: Voice[] }>("/voices")
      .then((d) => setVoices(d.voices))
      .catch(() => {});
  }, []);
  return (
    <main>
      <section className="hero container">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="tiny-wave">〰</span> ВАШЕТО АУДИО СТУДИО. НА
            БЪЛГАРСКИ.
          </span>
          <h1>
            Дайте глас
            <br />
            на думите си.
          </h1>
          <p className="hero-description">
            От първото изречение до цял подкаст.
            <br className="desktop" /> Създавайте аудио на български, което
            звучи
            <br className="desktop" /> точно като вашата идея.
          </p>
          <div className="hero-cta">
            <Link className="btn primary" to="/register">
              Създайте първия си запис <ArrowUpRight size={20} />
            </Link>
            <Link className="text-link" to="/voices">
              <Headphones size={18} />
              Разгледайте гласовете
            </Link>
          </div>
          <div className="hero-proof">
            <span>
              <Check size={14} />1 000 безплатни кредита
            </span>
            <span>
              <Check size={14} />
              Без банкова карта
            </span>
          </div>
        </div>
        <div className="hero-visual">
          <div className="orbit-label">
            <AudioLines size={15} />
            Написано от вас. Изговорено с характер.
          </div>
          <StudioPreview />
          <div className="hero-sticker">
            <Mic2 size={22} />
            <div>
              <strong>30 различни гласа</strong>
              <span>Намерете вашия.</span>
            </div>
          </div>
        </div>
      </section>
      <div className="format-strip">
        <div className="container">
          <span>ЕДНА ИДЕЯ. МНОГО НАЧИНИ ДА СЕ ЧУЕ.</span>
          <span>
            <Podcast />
            Подкасти
          </span>
          <span>
            <Video />
            Видеа и реклами
          </span>
          <span>
            <Headphones />
            Аудио уроци
          </span>
          <span>
            <FileText />
            Статии и истории
          </span>
        </div>
      </div>
      <section className="section container">
        <div className="section-heading">
          <div>
            <span className="eyebrow">
              ПО-МАЛКО ТЕХНИКА. ПОВЕЧЕ ТВОРЧЕСТВО.
            </span>
            <h2>
              Вашият текст.
              <br />
              Следващото му звучене.
            </h2>
          </div>
          <p>
            Не ви трябват микрофон, тиха стая
            <br />
            или часове пред аудио редактор.
            <br />
            Само нещо, което искате да кажете.
          </p>
        </div>
        <div className="features">
          <Link to="/app/studio" className="feature feature-green">
            <div className="feature-art art-text">
              <span>Здравей, свят.</span>
              <ArrowRight />
              <div className="mini-audio">
                <AudioLines />
                <Wave bars={17} small />
              </div>
            </div>
            <span className="feature-number">01 / ТЕКСТ В РЕЧ</span>
            <h3>
              Напишете го.
              <br />
              Нека се чуе.
            </h3>
            <p>
              Озвучавайте статии, истории и уроци. Изберете глас и изтеглете
              готовия запис.
            </p>
            <span className="feature-arrow">
              <ArrowUpRight />
            </span>
          </Link>
          <Link to="/app/studio?mode=podcast" className="feature feature-lilac">
            <div className="feature-art art-podcast">
              <div>
                <span className="voice-avatar Корал">М</span>
                <Wave bars={13} small />
              </div>
              <div>
                <Wave bars={13} small />
                <span className="voice-avatar Син">Б</span>
              </div>
            </div>
            <span className="feature-number">02 / ПОДКАСТ</span>
            <h3>
              Разговорът
              <br />
              започва с идея.
            </h3>
            <p>
              Подгответе сценарий с двама водещи. Дайте на всеки свой глас и
              създайте един общ запис.
            </p>
            <span className="feature-arrow">
              <ArrowUpRight />
            </span>
          </Link>
          <Link
            to="/app/studio?mode=voiceover"
            className="feature feature-peach"
          >
            <div className="feature-art art-video">
              <div className="video-box">
                <Video size={30} />
                <span>ВАШАТА ИСТОРИЯ</span>
              </div>
              <div className="video-track">
                <Wave bars={26} small />
              </div>
            </div>
            <span className="feature-number">03 / ОЗВУЧАВАНЕ</span>
            <h3>
              Доброто видео
              <br />
              заслужава глас.
            </h3>
            <p>
              Създайте аудио за следващата си реклама, кратко видео или
              презентация.
            </p>
            <span className="feature-arrow">
              <ArrowUpRight />
            </span>
          </Link>
        </div>
      </section>
      <section className="voices-section">
        <div className="container section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">ГЛАС С ХАРАКТЕР</span>
              <h2>
                Кой ще разкаже
                <br />
                вашата история?
              </h2>
            </div>
            <Link className="btn outline" to="/voices">
              Всички 30 гласа <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="voice-grid">
            {voices.slice(0, 6).map((v) => (
              <VoiceCard key={v.id} voice={v} />
            ))}
          </div>
          <p className="small-note">
            Гласовете са синтетични. Аудио примерите се добавят постепенно.
          </p>
        </div>
      </section>
      <section className="section container how-section">
        <div>
          <span className="eyebrow">ОТ ИДЕЯ ДО АУДИО</span>
          <h2>
            Три стъпки.
            <br />И сте в ефир.
          </h2>
          <Link to="/register" className="text-link">
            Отворете вашето студио <ArrowUpRight size={18} />
          </Link>
        </div>
        <div className="steps">
          {[
            [
              "01",
              "Добавете вашия текст",
              "Напишете, поставете или качете текстов файл. За подкаст разпределете репликите между двама водещи.",
            ],
            [
              "02",
              "Изберете как да звучи",
              "Намерете подходящия глас и настройте паузата между репликите.",
            ],
            [
              "03",
              "Създайте и споделете",
              "Преслушайте записа, изтеглете WAV файла и го добавете към вашето съдържание.",
            ],
          ].map(([n, t, d]) => (
            <div key={n}>
              <span>{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="section container faq-section">
        <div>
          <span className="eyebrow">ПРЕДИ ДА НАТИСНЕТЕ PLAY</span>
          <h2>Добри въпроси.</h2>
        </div>
        <div>
          {[
            [
              "Как се използват кредитите?",
              "В Аудио: 1 символ озвучен текст = 1 кредит. Във Видео студио: 3 кредита за символ, включително таговете за емоция, включително интервалите и пунктуацията. При подкаст етикетите на водещите не се таксуват. Видео използва 200 кредита на секунда за Ниско качество, 600 за Средно и 1 200 за Високо. Цената се показва преди генериране.",
            ],
            [
              "Мога ли да използвам аудиото за работа?",
              "Да, можете да го включвате в съдържание и клиентски проекти, когато имате необходимите права върху текста. Проверявайте произношението и спазвайте правилата на платформата, където публикувате.",
            ],
            [
              "Как работи подкастът?",
              "Въвеждате сценарий с редуващи се реплики на двама водещи. Всеки има отделен глас. Студиото озвучава репликите и ги комбинира в един WAV файл.",
            ],
            [
              "Какво става, ако записът се провали?",
              "При неуспешна генерация резервираните кредити се връщат автоматично. Можете да опитате отново.",
            ],
            [
              "Мога ли да прекратя абонамента?",
              "Да. Управлявате абонамента си от профила. При прекратяване той остава достъпен до края на вече платения период.",
            ],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <PlusIcon />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="container">
        <div className="closing">
          <AudioLines size={45} />
          <h2>
            Следващият ви запис
            <br />
            започва с едно изречение.
          </h2>
          <Link className="btn dark" to="/register">
            Дайте му глас <ArrowUpRight size={20} />
          </Link>
          <p>Опитайте безплатно. Без банкова карта.</p>
          <Wave bars={78} />
        </div>
      </section>
    </main>
  );
}
function PlusIcon() {
  return <span className="plus-icon">+</span>;
}
export function Pricing({ inApp = false }: { inApp?: boolean }) {
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  useEffect(() => {
    if (!inApp || !params.has("success")) return;
    let attempts = 0;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      if (++attempts >= 12) clearInterval(timer);
    }, 3000);
    return () => clearInterval(timer);
  }, [inApp, params.toString()]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const choose = async (id: string) => {
    if (!user) {
      location.href = "/register?plan=" + id;
      return;
    }
    if (id === "free") {
      location.href = "/app/studio";
      return;
    }
    setBusy(id);
    setError("");
    try {
      const d = await post(
        user.hasSubscription ? "/billing/portal" : "/billing/checkout",
        { plan: id },
      );
      location.href = d.url;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <main className={inApp ? "app-page" : "container section pricing-page"}>
      <div className={inApp ? "page-heading" : "center-heading"}>
        <span className="eyebrow">МЯСТО ЗА ВСЯКА ИДЕЯ</span>
        <h1>{inApp ? "Вашият абонамент" : "Добър глас. Ясна цена."}</h1>
        <p>Изберете място за вашите думи. Сменете плана, когато сте готови.</p>
      </div>
      {error && <Notice>{error}</Notice>}
      {inApp && params.has("success") && (
        <Notice good={user?.hasSubscription}>
          Плащането се проверява. Планът се обновява автоматично след
          потвърждение. Ако не се отрази, презаредете след малко.
        </Notice>
      )}
      {inApp && user && (
        <div className="billing-summary">
          <span>
            Използвани{" "}
            <strong>
              {user.used.toLocaleString("bg")} /{" "}
              {user.limit.toLocaleString("bg")}
            </strong>{" "}
            кредита
          </span>
          {user.periodEnd && (
            <span>
              Период до{" "}
              {new Date(user.periodEnd * 1000).toLocaleDateString("bg")}
            </span>
          )}
          {user.hasSubscription && (
            <Button
              onClick={() => choose("portal")}
              busy={busy === "portal"}
              className="btn outline"
            >
              Управление и фактури
            </Button>
          )}
        </div>
      )}
      <div className="pricing-grid">
        {plans.map((p) => (
          <article
            key={p.id}
            className={"price-card " + (p.id === "creator" ? "featured" : "")}
          >
            {p.id === "creator" && (
              <div className="recommended">ЗА АКТИВНИ СЪЗДАТЕЛИ</div>
            )}
            <h2>{p.name}</h2>
            <p>{p.description}</p>
            <div className="price">
              €{p.price}
              <span>{p.price ? "/ месец" : "/ еднократно"}</span>
            </div>
            <Button
              onClick={() => choose(p.id)}
              busy={busy === p.id}
              className={"btn " + (p.id === "creator" ? "primary" : "outline")}
            >
              {user?.hasSubscription
                ? "Управление на плана"
                : p.id === "free"
                  ? "Опитайте безплатно"
                  : "Изберете " + p.name}
              <ArrowUpRight size={16} />
            </Button>
            <ul>
              {p.features.map((f) => (
                <li key={f}>
                  <Check size={16} />
                  {f}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <div className="pricing-notes">
        <p><strong>Един баланс за аудио и видео.</strong> Аудио: 1 символ = 1 кредит. Премиум глас във Видео студио: 3 кредита за символ, включително таговете. Видео: Ниско качество — 200 кредита/сек.; Средно — 600; Високо — 1 200. Видеото използва готов запис с един глас от 5 до 60 секунди. Всяка започната секунда се закръгля нагоре; аудиото се таксува отделно.</p>
        <p>
          <ShieldCheck size={18} />
          Сигурно плащане. Прекратяване по всяко време.
        </p>
        <p>
          Цените са в евро. Приложимите данъци са включени в крайната цена при
          плащане. Месечните кредити не се прехвърлят. Безплатната проба изисква
          потвърден имейл.
        </p>
        <p>
          Един запис съдържа до 10 000 символа. Няма доплащане при достигане на
          лимита — генерацията спира до подновяване или промяна на плана.
        </p>
      </div>
    </main>
  );
}
export function Voices({ inApp = false }: { inApp?: boolean }) {
  const [voices, setVoices] = useState<Voice[]>(voiceList);
  const [filter, setFilter] = useState("Всички");
  const [query, setQuery] = useState("");
  useEffect(() => {
    api<{ voices: Voice[] }>("/voices")
      .then((d) => setVoices(d.voices))
      .catch(() => {});
  }, []);
  const list = voices.filter(
    (v) =>
      (filter === "Всички" || v.gender === filter) &&
      (v.name + " " + v.tone).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className={inApp ? "app-page" : "container section"}>
      <div className="page-heading">
        <span className="eyebrow">30 ГЛАСА. БЕЗБРОЙ ИСТОРИИ.</span>
        <h1>Намерете вашето звучене.</h1>
        <p>
          От спокоен разказ до енергична реклама. Изберете характера на
          следващия си запис.
        </p>
      </div>
      <div className="filter-bar">
        <div className="segmented">
          {["Всички", "Женски", "Мъжки"].map((f) => (
            <button
              className={f === filter ? "active" : ""}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Търсене на глас"
          placeholder="Търсете име или звучене…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="voice-grid">
        {list.map((v) => (
          <VoiceCard
            key={v.id}
            voice={v}
            onSelect={() => {
              location.href = "/app/studio?voice=" + v.id;
            }}
          />
        ))}
      </div>
      {!list.length && (
        <div className="empty-state">
          Няма гласове с това име. Опитайте друго търсене.
        </div>
      )}
      <p className="small-note">
        Имената обозначават синтетични гласове. Описанията са ориентировъчни;
        проверете звученето с вашия текст. Примерите предстои да бъдат качени.
      </p>
    </main>
  );
}
export function About() {
  return (
    <main className="container section about">
      <span className="eyebrow">ЗА РЕЧ БГ</span>
      <h1>
        Добрите идеи
        <br />
        заслужават да се чуват.
        <br />И на български.
      </h1>
      <div className="about-visual">
        <AudioLines size={72} />
        <Wave bars={60} />
        <span>речбг</span>
      </div>
      <div className="prose">
        <h2>Създадено от Радослав Додников.</h2>
        <p>
          Реч БГ е проект на Радослав Додников, софтуерен и AI инженер от София
          и основател на{" "}
          <a href="https://kova.bg" rel="noopener">
            Кова студио
          </a>{" "}
          — създателят на Записки БГ.
        </p>
        <h2>Повече време за това, което искате да кажете.</h2>
        <p>
          Реч БГ е аудио студио за хора, които създават съдържание на български
          — преподаватели, автори, маркетолози и малки бизнеси. Събираме текста,
          гласовете и готовите записи в едно спокойно работно пространство.
        </p>
        <p>
          Идеята е проста: озвучаването не трябва да е пречката между добрия
          текст и неговата публика. Можете да започнете с едно изречение, да
          подготвите урок или да запишете разговор с двама водещи.
        </p>
        <h2>Вашият текст остава ваш.</h2>
        <p>
          Не публикуваме вашите проекти в общ каталог. Записите са достъпни през
          профила ви. Вие решавате какво да изтеглите и къде да го използвате.
        </p>
        <h2>Създадено с внимание към езика.</h2>
        <p>
          Български интерфейс, ясни цени и гласове с различен характер.
          Синтетичната реч понякога греши с ударения, имена и съкращения —
          затова преслушването е важна част от работата.
        </p>
        <Link className="btn primary" to="/contact">
          Нека поговорим <ArrowUpRight size={18} />
        </Link>
      </div>
    </main>
  );
}
export function Contact() {
  const [contact, setContact] = useState<{ email?: string; phone?: string }>(
    {},
  );
  useEffect(() => {
    api("/public/config")
      .then((d) => setContact(d.company))
      .catch(() => {});
  }, []);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [good, setGood] = useState(false);
  return (
    <main className="container section contact-page">
      <div>
        <span className="eyebrow">НА ЛИНИЯ СМЕ</span>
        <h1>Нека поговорим.</h1>
        <p>
          Въпрос за вашия запис, идея за функция
          <br />
          или нещо, което можем да направим по-добре?
        </p>
        <div className="contact-direct">
          {contact.email && (
            <p>
              <a href={"mailto:" + contact.email}>{contact.email}</a>
            </p>
          )}
          {contact.phone && (
            <p>
              Телефон:{" "}
              <a href={"tel:" + contact.phone}>
                {contact.phone === "+35924920201"
                  ? "02 492 0201"
                  : contact.phone}
              </a>
            </p>
          )}
        </div>
        <div className="contact-note">
          <Mic2 size={30} />
          <h3>Слушаме внимателно.</h3>
          <p>
            Опишете какво искате да постигнете. Ако има проблем, добавете името
            на проекта.
          </p>
        </div>
      </div>
      <form
        className="form-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          const form = e.currentTarget;
          const d = Object.fromEntries(new FormData(form));
          try {
            await post("/contact", d);
            setGood(true);
            setMessage(
              "Получихме съобщението ви. Ще отговорим на посочения имейл.",
            );
            form.reset();
          } catch (err) {
            setGood(false);
            setMessage((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Вашето име
          <input name="name" autoComplete="name" required maxLength={100} />
        </label>
        <label>
          Имейл за отговор
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
          />
        </label>
        <label>
          Как можем да помогнем?
          <textarea
            name="message"
            rows={6}
            required
            minLength={10}
            maxLength={5000}
          />
        </label>
        <input
          className="honeypot"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        <p className="small-note">
          Използваме данните само за отговор на запитването.{" "}
          <Link to="/privacy">Поверителност</Link>
        </p>
        {message && <Notice good={good}>{message}</Notice>}
        <Button busy={busy} className="btn dark" type="submit">
          Изпратете съобщение <ArrowUpRight size={17} />
        </Button>
      </form>
    </main>
  );
}
const legalContent: Record<
  string,
  { title: string; sections: [string, string][] }
> = {
  terms: {
    title: "Общи условия",
    sections: [
      [
        "1. За услугата",
        "Реч БГ предоставя онлайн инструменти за преобразуване на текст в синтетична реч за създаване на аудио разговори и говорещи видео аватари. Услугата е за лица на 18 или повече години. Регистрацията изисква валиден имейл, парола и приемане на настоящите условия.",
      ],
      [
        "2. Вашият профил",
        "Вие отговаряте за достъпа до профила си и за точността на данните. Не предоставяйте паролата си на други лица. При съмнение за неоторизиран достъп сменете паролата си и се свържете с нас.",
      ],
      [
        "3. Текстове и записи",
        "Запазвате правата си върху подадените текстове. Давате ни ограничено разрешение да ги обработваме и съхраняваме за изпълнение на услугата. Носите отговорност да имате необходимите права и разрешения за съдържанието, включително за качения портрет и съгласието на изобразения човек. Можете да използвате изтеглените записи в лични и търговски проекти при спазване на приложимите права и закона. Не гарантираме изключителност на синтетичните гласове или възникване на авторски права върху всеки резултат.",
      ],
      [
        "4. Допустима употреба",
        "Забранени са измами, представяне за реално лице без разрешение, нарушаване на авторски права, незаконно съдържание и заобикаляне на лимитите чрез множество профили. При установено нарушение можем да ограничим достъпа, като уведомим потребителя, когато законът позволява.",
      ],
      [
        "5. Цени и абонаменти",
        "Платените планове са месечни и се подновяват автоматично до прекратяване. Размерът, валутата и приложимите данъци се показват преди плащане. Кредитите са общ баланс за аудио и видео: В Аудио: 1 символ озвучен текст = 1 кредит. Във Видео студио: 3 кредита за символ, включително таговете за емоция. Видео струва 200 кредита за започната секунда за Ниско качество, 600 за Средно и 1 200 за Високо. Цената за видео е допълнителна към вече създаденото аудио и се потвърждава преди заявката. Неуспешно видео връща само кредитите за видеото. Неизползваните месечни кредити не се прехвърлят. Провалена генерация възстановява резервираните кредити. Управлението на плащанията и фактурите е достъпно от профила.",
      ],
      [
        "6. Качество и достъпност",
        "Резултатите се генерират автоматично и може да съдържат грешки в произношението, ударението или интонацията. Преслушвайте и преглеждайте резултатите преди публикуване. Видеото може да съдържа визуални неточности или несъвършена синхронизация на устните. Не обещаваме непрекъсната достъпност или конкретно време за генериране. Това не ограничава законовите ви потребителски права.",
      ],
      [
        "7. Прекратяване и промени",
        "Можете да прекратите подновяването от страницата за абонамента. Достъпът по платения план продължава до края на платения период. Съществени промени в цените и условията се съобщават предварително и не променят със задна дата платен период.",
      ],
      [
        "8. Приложимо право и спорове",
        "Прилага се българското право, без да се ограничават задължителни права на потребителите. Първо се свържете с нас чрез контактната форма. Можете да подадете жалба до Комисията за защита на потребителите или до компетентния съд. Вижте и политиката за отказ и възстановяване.",
      ],
    ],
  },
  privacy: {
    title: "Политика за поверителност",
    sections: [
      [
        "1. Какви данни обработваме",
        "Име и имейл, защитен хеш на паролата, текстове на проекти, качени портрети, генерирани аудио и видео записи, данни за използваните кредити, идентификатори за абонамента и кореспонденция с поддръжката. За защита от злоупотреби пазим ограничени технически записи и краткотрайни хеширани идентификатори. Не съхраняваме пълни данни за банкови карти.",
      ],
      [
        "2. Защо ги използваме",
        "Изпълнение на договора: профил, аудио и видео генерация, съхранение и плащания. Законово задължение: счетоводни и данъчни документи, когато е приложимо. Легитимен интерес: сигурност, предотвратяване на злоупотреби и отговор на запитвания. Не изпращаме маркетингови писма без отделно основание.",
      ],
      [
        "3. Доставчици и получатели",
        "Използваме Cloudflare за хостинг, съхранение, обработка на аудио и служебни имейли и Stripe за плащания. За премиум озвучаване във Видео студио изпращаме сценария и избрания глас към ElevenLabs. За предложения за емоции обработваме сценария чрез AI услугата на Cloudflare. Времената на думите се пазят със записа, а финалният експорт със субтитри се извършва във вашия браузър. При заявено видео изпращаме избрания аудиозапис и портрета към WaveSpeedAI при Ниско качество или към fal.ai при Средно и Високо качество, както и към съответния доставчик на видео услугата. Тези доставчици и техните подизпълнители могат да обработват данни извън ЕИП при приложимите договорни гаранции. Не продаваме личните ви данни. Не използваме проектите ви за собствено обучение на модели.",
      ],
      [
        "4. Срокове за съхранение",
        "Проектите и записите се пазят до изтриване от вас или до закриване на профила. Непотвърдените регистрации се премахват след 7 дни. Сесиите изтичат до 30 дни. Линковете за потвърждение важат 24 часа, а тези за възстановяване — 1 час. Запитванията се изтриват след 12 месеца. Необходимите счетоводни записи при платежния доставчик се пазят за законовите срокове. Резервни копия и ограничени технически логове могат да имат отделни срокове според доставчика.",
      ],
      [
        "5. Вашите права",
        "Имате право на достъп, поправка, изтриване, ограничаване, преносимост и възражение при условията на GDPR. Можете да изтеглите данните и да изтриете профила от настройките. За допълнителни искания използвайте контактната форма. Можете да подадете жалба до Комисията за защита на личните данни — cpdp.bg.",
      ],
      [
        "6. Сигурност",
        "Използваме защитени връзки, хеширани пароли и сесии, както и проверка на собствеността при достъп до записи. Изтриването на профила изисква повторно въвеждане на паролата и предварително прекратяване на активен абонамент. Не включвайте чужди чувствителни данни в текстовете без подходящо основание.",
      ],
    ],
  },
  cookies: {
    title: "Политика за бисквитки",
    sections: [
      [
        "Само необходимото",
        "Реч БГ използва необходима сесийна бисквитка rech_session за удостоверяване на входа. Тя е HttpOnly, SameSite=Lax и Secure при HTTPS, с максимален срок 30 дни. Няма рекламни или аналитични бисквитки в приложението.",
      ],
      [
        "Защита на регистрацията",
        "Когато е активирана защитата от автоматизирани регистрации, Cloudflare Turnstile проверява браузъра. Платежните страници на Stripe могат да използват собствени необходими технологии за сигурност.",
      ],
      [
        "Вашият контрол",
        "Можете да изтриете бисквитките от настройките на браузъра или да излезете от профила си. Блокирането на сесийната бисквитка пречи на входа. Ако добавим незадължителни технологии, ще предоставим отделен избор преди активирането им.",
      ],
    ],
  },
  refunds: {
    title: "Отказ и възстановяване",
    sections: [
      [
        "Прекратяване на подновяването",
        "Отворете „Абонамент“ в профила и изберете управление. Можете да спрете следващото подновяване по всяко време. Това не заличава вече платения период и достъпът продължава до края му.",
      ],
      [
        "Право на отказ",
        "Ако сте потребител, по правило имате 14 дни от сключване на договора за упражняване на право на отказ. За искане използвайте контактната форма и посочете имейла на профила, датата на плащане и че желаете отказ. Не е необходимо да посочвате причина.",
      ],
      [
        "Начало на услугата",
        "Активирането на услугата и използването на кредити сами по себе си не премахват законовото право на отказ. Настоящият процес не изисква отказ от това право. Исканията се разглеждат съобразно приложимите правила за услуги и цифрово съдържание.",
      ],
      [
        "Проблем с генерацията",
        "При неуспешен запис резервираните кредити се връщат автоматично. Ако записът е повреден или възстановяването не се е отразило, изпратете името на проекта през контактната форма.",
      ],
      [
        "Възстановяване на плащане",
        "При основателно искане възстановяваме сумата по използвания платежен метод в законовия срок. Банката може да изисква допълнително време за отразяване. Тази политика не ограничава права при несъответствие или други задължителни потребителски права.",
      ],
    ],
  },
};
export function Legal({ page }: { page: string }) {
  const [company, setCompany] = useState<{
    name?: string;
    address?: string;
    city?: string;
    phone?: string;
    id?: string;
    email?: string;
  }>({});
  useEffect(() => {
    api("/public/config")
      .then((d) => setCompany(d.company))
      .catch(() => {});
  }, []);
  const c = legalContent[page];
  return (
    <main className="container section legal-page">
      <span className="eyebrow">ЯСНИ ПРАВИЛА</span>
      <h1>{c.title}</h1>
      <p className="small-note">Последна актуализация: 11 септември 2026 г.</p>
      {company.name ? (
        <div className="legal-operator">
          <strong>Доставчик: {company.name}</strong>
          {company.id && <p>ЕИК: {company.id}</p>}
          {company.address ? (
            <p>Адрес: {company.address}</p>
          ) : company.city ? (
            <p>Град: {company.city}</p>
          ) : null}
          {company.email && (
            <p>
              Контакт: <a href={"mailto:" + company.email}>{company.email}</a>
            </p>
          )}
          {company.phone && (
            <p>
              Телефон:{" "}
              <a href={"tel:" + company.phone}>
                {company.phone === "+35924920201"
                  ? "02 492 0201"
                  : company.phone}
              </a>
            </p>
          )}
        </div>
      ) : (
        <Notice>
          Услугата е в подготовка за пускане. Данните на доставчика ще бъдат
          публикувани преди активиране на регистрации и плащания.
        </Notice>
      )}
      <div className="prose">
        {c.sections.map(([h, p]) => (
          <section key={h}>
            <h2>{h}</h2>
            <p>{p}</p>
          </section>
        ))}
        <p>
          За въпроси и упражняване на права:{" "}
          <Link to="/contact">свържете се с нас</Link>.
        </p>
      </div>
    </main>
  );
}
export function NotFound() {
  return (
    <main className="not-found">
      <Logo />
      <span>404</span>
      <h1>Тук все още е тихо.</h1>
      <p>Страницата не съществува или е преместена.</p>
      <Link className="btn primary" to="/">
        Към началото <ArrowUpRight />
      </Link>
    </main>
  );
}
