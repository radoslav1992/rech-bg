# Пускане на Реч БГ в Cloudflare

Приложението е **Worker със статични assets**, а не Cloudflare Pages проект. Не е нужен отделен Node.js сървър или Supabase.

## 1. Потвърдена конфигурация

| Поле | Стойност |
| --- | --- |
| Домейн | `https://rechbg.com` |
| D1 име / binding | `rech-bg` / `DB` |
| D1 UUID | `4916f5c6-41cd-48a9-ba0e-25e2554701b4` |
| Доставчик | Радослав Додников (Кова студио) |
| Град | София |
| Публичен имейл | `info@rechbg.com` |
| Телефон | `02 492 0201` |

Контактният имейл е зададен от собственика на `info@rechbg.com`. Останалите данни за доставчика са взети от `notebook`: `src/pages/privacy.astro`, `src/pages/contact.astro`, `src/pages/za-nas.astro` и `src/lib/email.ts`. Там не са посочени ЕИК и пълен бизнес адрес; `COMPANY_ID` и `COMPANY_ADDRESS` остават за попълване. София е град, а не заместител на пълен адрес.

Публичните стойности са defaults в `server/config.ts`. Cloudflare Dashboard variables могат да ги заменят и остават запазени при deploy. Имейлът за контакт не задава автоматично подател на писма или администраторски права. Задайте отделно `EMAIL_FROM` и `ADMIN_EMAILS`.

## 2. Cloudflare ресурси

D1 UUID вече е закрепен в `wrangler.jsonc`; не създавайте втора база. Необходим е достъп до акаунта, в който се намира тази база, платен Workers план за CPU лимита и наличен достъп до избрания партньорски AI модел.

Създайте частния R2 bucket, ако още не съществува:

```sh
npx wrangler login
npx wrangler r2 bucket create rech-bg-audio
```

Приложете миграцията върху съществуващата база:

```sh
npx wrangler d1 migrations apply rech-bg --remote
```

Тази команда не е изпълнявана от асистента в Cloudflare акаунта. Самото предоставяне на UUID не създава таблиците.

Custom Domain `rechbg.com` е деклариран в `wrangler.jsonc`. Зоната `rechbg.com` трябва да е активна в същия Cloudflare акаунт; `wrangler deploy` прилага връзката с Worker. Декларацията в GitHub не потвърждава, че DNS или домейнът вече са активирани.

AI binding `AI` и Workflow binding `GENERATION` също са декларирани. Не е нужен Google API ключ. R2 остава частен.

## 3. GitHub интеграция

Cloudflare → Workers & Pages → Create → Import a repository → `radoslav1992/rech-bg`.

| Поле | Стойност |
| --- | --- |
| Тип | Worker / Workers Builds |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `npm ci && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node version | `24` |

Не задавайте `dist` като единствен statically hosted сайт — API, D1 и Workflows се изпълняват от `server/index.ts`.

`keep_vars: true` е запазено по примера на `notebook`. В конфигурацията **няма `vars` блок**, така че стойностите в Cloudflare Dashboard не се презаписват при следващ deploy.

## 4. Variables and Secrets

Задайте в **Worker → Settings → Variables and Secrets**:

| Име | Вид | Стойност / предназначение |
| --- | --- | --- |
| `SITE_URL` | Variable | По подразбиране `https://rechbg.com`; задайте само за override |
| `APP_ENV` | Variable | `production` |
| `COMPANY_NAME` | Variable | По подразбиране `Радослав Додников (Кова студио)` |
| `COMPANY_ID` | Variable | ЕИК / регистрационен номер |
| `COMPANY_ADDRESS` | Variable | Пълен адрес на доставчика — предстои да бъде предоставен |
| `COMPANY_CITY` | Variable | По подразбиране `София`; не замества пълния адрес |
| `CONTACT_PHONE` | Variable | По подразбиране `+35924920201` |
| `CONTACT_EMAIL` | Variable | По подразбиране `info@rechbg.com` |
| `ADMIN_EMAILS` | Variable | Администраторски имейл; няколко се разделят със запетая |
| `REGISTRATION_ENABLED` | Variable | `false` до финална проверка, след това `true` |
| `BILLING_ENABLED` | Variable | `false` до тест на плащанията, след това `true` |
| `EMAIL_FROM` | Variable | Например `Реч БГ <noreply@your-domain.bg>` от верифициран домейн |
| `RESEND_API_KEY` | Secret | Resend ключ за служебни писма |
| `TURNSTILE_SITE_KEY` | Variable | Публичен ключ на Turnstile widget за финалния домейн |
| `TURNSTILE_SECRET_KEY` | Secret | Съответният таен ключ |
| `STRIPE_SECRET_KEY` | Secret | Първо тестов Stripe ключ, после продукционен |
| `STRIPE_WEBHOOK_SECRET` | Secret | Подписващият secret на endpoint-а за същия режим |
| `STRIPE_PRICE_STARTER` | Variable | Stripe Price ID за €9/месец |
| `STRIPE_PRICE_CREATOR` | Variable | Stripe Price ID за €19/месец |
| `STRIPE_PRICE_STUDIO` | Variable | Stripe Price ID за €39/месец |

Не са нужни `SESSION_SECRET`, JWT secret, публичен Stripe ключ или Google API ключ. Сесиите използват криптографски случайни токени, само хешовете се пазят в D1. Stripe Checkout работи със server-created redirect URL.

Turnstile е задължителен за продукционна регистрация. Само локалният `APP_ENV=development` допуска работа без него. Не използвайте development в продукция.

Контактната форма записва съобщенията в D1. Администраторът ги вижда в **Настройки → Запитвания от сайта**. Не е включено автоматично изпращане на отговори.

## 5. Stripe

Създайте **три месечни recurring prices**, в EUR, с **inclusive tax behavior**:

| Variable | Име | unit_amount | Период |
| --- | --- | ---: | --- |
| `STRIPE_PRICE_STARTER` | Реч БГ — Начало | 900 | 1 месец |
| `STRIPE_PRICE_CREATOR` | Реч БГ — Създател | 1900 | 1 месец |
| `STRIPE_PRICE_STUDIO` | Реч БГ — Студио | 3900 | 1 месец |

Конфигурирайте Stripe Tax според действителните си регистрации и правилната категория на услугата. Checkout използва `automatic_tax.enabled=true`; неправилна Tax конфигурация блокира плащане и трябва да се отстрани в Stripe. Приложението проверява активност, EUR, сума, месечен период и включени данъци, за да не продава различна цена от публикуваната.

Активирайте Customer Portal с:

- преглед на фактури и промяна на платежен метод;
- прекратяване в края на текущия период;
- само трите разрешени продукта/цени, една subscription item и quantity 1;
- за първото пускане изключете незабавната смяна на план; ако активирате смени, използвайте поддържана конфигурация с незабавно платена фактура за upgrade и downgrade в края на периода. Тествайте точния процес преди отваряне.

Регистрирайте webhook:

```
https://rechbg.com/api/billing/webhook
```

Събития:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Endpoint-ът проверява подписа върху оригиналното тяло. Redirect към `success=1` **не предоставя платен достъп**. Предоставя го текущ активен абонамент с платена последна фактура, потвърден чрез подписан event и повторно прочетен от Stripe. Повторени events не дублират символи. Отказан абонамент става безплатен; вече изразходваните trial символи не се нулират.

За да не се създават паралелни абонаменти, отворен checkout се използва повторно за около 32 минути. Ако клиентът смени избрания план, докато има отворен checkout, ще види вече избраната цена в платежния екран. След изтичането му може да избере наново. При съществуващ абонамент бутоните водят към портала.

Обработката на refund/chargeback е чрез Stripe Dashboard и поддръжката. При възстановяване на цяла покупка прекратете и съответния абонамент в Stripe, ако достъпът трябва да спре; `charge.refunded` самостоятелно не прекратява subscription. Потребителските права са описани в страницата за отказ; не е включено автоматично отказване от тях при checkout.

## 6. Качване на гласове

1. Регистрирайте и потвърдете администраторския имейл от `ADMIN_EMAILS`.
2. Отворете **Настройки → Примери на гласовете**.
3. Изберете българското име и качете WAV или MP3 до 2 MB.
4. Проверете публичния каталог. Безплатното прослушване на пример не извиква AI и не използва потребителска квота.

За записване извън приложението точната връзка между българските имена и техническите гласове е в [VOICES.md](VOICES.md). Тази документация е за оператора; клиентските bundles и `/api/voices` не съдържат техническите имена.

## 7. Приемане преди пускане

- Проверете на десктоп и телефон началото, цени, правни страници, регистрация и студио.
- Регистрирайте нов тестов потребител и потвърдете имейла. Проверете забравена парола.
- Създайте кратък български WAV и подкаст с `1:` / `2:`. Преслушайте целия резултат.
- Проверете квотата, повторно натискане на генериране, провален AI отговор и собствеността на файловете между два профила.
- В Stripe test mode минете Checkout, webhook, фактура, отказано плащане, renewal и cancellation. Проверете показаните крайни суми/данъци.
- Прегледайте попълнените условия и данни на действителния доставчик.
- Добавете реалните аудио примери. Включете `REGISTRATION_ENABLED=true` и `BILLING_ENABLED=true` едва след готовност.

При следваща промяна по базата добавете нова миграция. Не редактирайте вече приложена продукционна миграция. Използвайте D1 backups/Time Travel и R2 lifecycle за `segments/` (например изтриване след 7 дни) като допълнителна защита срещу оставени временни файлове.
