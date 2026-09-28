// Page titles and descriptions shared by the Worker (first response) and the SPA (in-app navigation).
export const SITE_NAME = "Реч БГ";
export const defaultDescription =
  "Създавайте аудио на български, видеа с говорещи аватари и стилни субтитри. Едно AI студио за вашите истории, реклами и продукти.";
/** Indexable marketing and legal pages, also listed in sitemap.xml. */
export const publicPages: Record<string, { title: string; description: string }> = {
  "/": { title: "Дайте глас на думите си", description: defaultDescription },
  "/pricing": {
    title: "Цени",
    description:
      "Месечни планове Проба, Начало, Създател и Студио. Всички гласове и формати са включени във всеки план в рамките на кредитите.",
  },
  "/voices": {
    title: "30 гласа на български",
    description:
      "Чуйте 30 естествени гласа на български за разкази, реклами, подкасти и озвучаване на видео.",
  },
  "/about": {
    title: "За нас",
    description: "Реч БГ е българско студио за създаване на аудио и видео с изкуствен интелект.",
  },
  "/contact": {
    title: "Контакт",
    description: "Свържете се с екипа на Реч БГ за въпроси, фактуриране и поддръжка.",
  },
  "/terms": { title: "Общи условия", description: "Общите условия за използване на Реч БГ." },
  "/privacy": {
    title: "Поверителност",
    description: "Как Реч БГ събира, използва и защитава личните ви данни.",
  },
  "/cookies": { title: "Бисквитки", description: "Какви бисквитки използва Реч БГ и защо." },
  "/refunds": {
    title: "Отказ и възстановяване",
    description: "Правила за отказ от абонамент и възстановяване на плащания в Реч БГ.",
  },
};
/** Pages that exist but must not be indexed. */
const privateTitles: Record<string, string> = {
  "/login": "Вход",
  "/register": "Регистрация",
  "/forgot": "Забравена парола",
  "/reset": "Нова парола",
  "/verify": "Потвърждение на имейл",
  "/app": "Табло",
  "/app/studio": "Аудио студио",
  "/app/video-studio": "Видео студио",
  "/app/media": "Медийни инструменти",
  "/app/projects": "Моите проекти",
  "/app/voices": "Гласове",
  "/app/billing": "Абонамент",
  "/app/settings": "Настройки",
};
const notFoundTitle = "Страницата не е намерена";
const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
/** The route the SPA renders for `path`, e.g. "/app/studio/123" → "/app/studio"; null for its 404 page. */
export function knownRoute(path: string): string | null {
  const p = normalize(path);
  if (publicPages[p] || privateTitles[p]) return p;
  const detail = /^(\/app\/(?:studio|video-studio))\/[^/]+$/.exec(p);
  return detail ? detail[1] : null;
}
export function pageMeta(path: string) {
  const route = knownRoute(path);
  const page = route ? publicPages[route] : undefined;
  const title = page?.title || (route ? privateTitles[route] : notFoundTitle);
  return {
    route,
    title: `${title} — ${SITE_NAME}`,
    description: page?.description || defaultDescription,
    indexable: !!page,
  };
}
