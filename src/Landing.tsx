import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, AudioLines, Captions, Check, ChevronDown, Film, ImagePlus, Mic2, MoveUpRight, Podcast, Sparkles, Upload, WandSparkles } from "lucide-react";
import { plans, voiceList } from "../shared/catalog";
import { api, useAuth, VoiceCard, Wave, type Voice } from "./lib";

const portraits = [
  { id: "mila", name: "Мила", role: "Истории с характер", image: "/images/avatars/mila.webp" },
  { id: "boris", name: "Борис", role: "Идеи, които се чуват", image: "/images/avatars/boris.webp" },
  { id: "elena", name: "Елена", role: "Лице за вашия бранд", image: "/images/avatars/elena.webp" },
];
const questions = [
  ["Какво мога да създам с Реч БГ?", "Аудио от текст, подкасти с два гласа, видеа с говорещ аватар и изображения на аватар с ваш продукт. Можете да добавите и редактирате субтитри, след което да ги вградите в готовото видео."],
  ["Трябва ли да се снимам пред камера?", "Не. За видео качвате портрет, за който имате право на използване и съгласие на изобразения човек. След това добавяте сценарий и избирате глас. Портретите на тази страница са AI-генерирани илюстрации."],
  ["Мога ли да пробвам безплатно?", "Да. След регистрация и потвърждение на имейла получавате 1 000 кредита за проба на аудио. Не е нужна банкова карта. Видео и изображения използват повече кредити; точната цена се показва преди създаване."],
  ["Как работят кредитите?", "Един баланс покрива всички инструменти. Обикновеното аудио използва 1 кредит за символ, а премиум гласът — 3. Видеото се таксува според продължителността и качеството. Вижте всички тарифи на страницата с цените."],
  ["Трябва ли да чакам в отворения прозорец?", "Генерирането и сървърният видео експорт продължават във фонов режим. Завършете качването на файловете, преди да затворите страницата. Готовите резултати ще ви очакват в профила."],
  ["Колко дълго пазите файловете?", "Записите се пазят според плана: 7, 30, 90 или 180 дни. Генерираните продуктови варианти са налични 7 дни, с възможност за запазване в библиотеката при платен план. Срокът е видим до файла."],
];

export function Landing() {
  const { user } = useAuth();
  const [selected, setSelected] = useState(0);
  const [caption, setCaption] = useState("classic");
  const [voices, setVoices] = useState<Voice[]>(voiceList);
  useEffect(() => { let live = true; api<{voices: Voice[]}>("/voices").then(d => { if (live) setVoices(d.voices); }).catch(() => {}); return () => { live = false; }; }, []);
  const start = user ? "/app/video-studio" : "/register";
  const portrait = portraits[selected];
  return <main className="creator-landing">
    <section className="creator-hero">
      <div className="container creator-hero-grid">
        <div className="creator-hero-copy">
          <span className="creator-kicker"><Sparkles size={15} /> ВАШЕТО AI СТУДИО НА БЪЛГАРСКИ</span>
          <h1>Вашите идеи.<br />С глас.<br />С лице. С живот.</h1>
          <p>Превърнете текста в глас, а една снимка — в говорещо видео. Създавайте истории, реклами и съдържание, което е ваше.</p>
          <div className="creator-actions"><Link className="btn primary" to={start}>Започнете да създавате <ArrowUpRight size={19}/></Link><a className="btn outline" href="#how-it-works">Как работи <ArrowRight size={18}/></a></div>
          <div className="creator-proof"><span><Check size={15}/>1 000 кредита за аудио проба</span><span><Check size={15}/>Без банкова карта</span></div>
          <div className="creator-platforms"><span>СЪЗДАДЕНО ЗА ВАШИЯ ФОРМАТ</span><div><b>Reels</b><i/><b>TikTok</b><i/><b>YouTube</b><i/><b>Подкасти</b></div></div>
        </div>
        <div className="creator-showcase">
          <div className="creator-orbit" aria-hidden="true"/>
          <img className="creator-arrow" src="/images/theme/creator-arrow.svg" alt="" aria-hidden="true"/>
          <div className="creator-float creator-float-top"><span className="creator-icon"><AudioLines size={20}/></span><div><strong>Думите стават глас.</strong><span>На вашия език.</span></div><Wave bars={12}/></div>
          <figure className="creator-main-portrait">
            <img key={portrait.id} src={portrait.image} alt={`AI-генериран примерен аватар ${portrait.name}`} width="900" height="1200" fetchPriority="high"/>
            <span className="creator-image-badge"><span/>AI АВАТАР · ПРИМЕР</span>
            <figcaption><div><strong>{portrait.name}</strong><span>{portrait.role}</span></div><span className="creator-camera"><Film size={21}/></span></figcaption>
          </figure>
          <div className="creator-picker" aria-label="Примерни аватари">{portraits.map((p, i) => <button key={p.id} aria-label={`Покажи ${p.name}`} aria-pressed={i === selected} onClick={() => setSelected(i)}><img src={p.image} alt="" width="60" height="72"/><span>{p.name}</span></button>)}</div>
          <div className="creator-float creator-float-bottom"><span className="creator-icon"><Captions size={21}/></span><div><strong>История, която се вижда.</strong><span>Глас + аватар + субтитри</span></div></div>
        </div>
      </div>
    </section>
    <section className="creator-strip" aria-label="Възможности"><div className="container">{[[AudioLines,"Текст в реч"],[Film,"Говорещи аватари"],[Podcast,"Подкасти"],[Captions,"Стилни субтитри"],[ImagePlus,"Аватар с продукт"]].map(([Icon,label]) => { const I = Icon as typeof Film; return <span key={String(label)}><I size={20}/>{String(label)}</span>; })}</div></section>

    <section className="container creator-section" id="tools">
      <div className="creator-section-head"><div><span className="creator-kicker">ОТ ИДЕЯ ДО ГОТОВО СЪДЪРЖАНИЕ</span><h2>Едно студио.<br/>Много начини да бъдете чути.</h2></div><p>Изберете формат. Дайте му свой характер. Останалото създайте на едно място.</p></div>
      <div className="creator-tools">{[
        {Icon:AudioLines,n:"01",title:"Дайте глас на текста",text:"Естествена реч за вашите истории, уроци и подкасти. Изберете глас и чуйте разликата.",to:"/app/studio",label:"Аудио студио",type:"audio"},
        {Icon:Film,n:"02",title:"Дайте лице на историята",text:"Качете портрет, добавете сценарий и създайте видео с изразителен глас и синхрон на устните.",to:"/app/video-studio",label:"Видео студио",type:"video"},
        {Icon:Captions,n:"03",title:"Думите остават в кадър",text:"Качете видео или използвайте създаденото. Редактирайте субтитрите и ги вградете в MP4.",to:"/app/media",label:"Медийни инструменти",type:"captions"},
      ].map(({Icon,n,title,text,to,label,type}) => <article className={`creator-tool ${type}`} key={n}><div className="creator-tool-top"><span className="creator-icon"><Icon size={26}/></span><span>{n}</span></div><h3>{title}</h3><p>{text}</p><Link to={to}>{label}<ArrowUpRight size={20}/></Link></article>)}</div>
    </section>

    <section className="creator-process" id="how-it-works"><div className="container creator-section"><div className="creator-center-head"><span className="creator-kicker">ПО-МАЛКО ПОДГОТОВКА. ПОВЕЧЕ ТВОРЧЕСТВО.</span><h2>От първото изречение<br/>до вашето следващо видео.</h2></div><div className="creator-steps">{[
      {Icon:Upload,n:"01",title:"Добавете своята идея",text:"Напишете сценарий и качете портрет. Имате продукт? Дайте му място в кадъра."},
      {Icon:Mic2,n:"02",title:"Изберете как да звучи",text:"Изберете глас, добавете емоция и преслушайте аудиото, преди да създадете видео."},
      {Icon:WandSparkles,n:"03",title:"Направете го свое",text:"Изберете качество, оформете субтитрите и изтеглете готовото видео за вашия канал."},
    ].map(({Icon,n,title,text}) => <article key={n}><div className="creator-step-visual"><Icon size={34}/><span>{n}</span></div><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>

    <section className="container creator-section creator-split" id="examples"><div className="creator-caption-demo"><div className="creator-demo-top"><span><Captions size={18}/> ВАШИТЕ СУБТИТРИ</span><span>9:16</span></div><div className="creator-caption-frame"><img src="/images/avatars/elena.webp" alt="AI-генериран портрет с примерен стил на субтитри" width="900" height="1200" loading="lazy"/><span className={`creator-demo-caption ${caption}`}>Една идея.<br/><b>Вашата история.</b></span><span className="creator-demo-label">ВИЗУАЛЕН ПРЕГЛЕД</span></div><div className="creator-caption-options" aria-label="Примерни стилове на субтитри">{[["classic","Класически"],["highlight","Акцент"],["minimal","Минимален"]].map(([id,label]) => <button key={id} aria-pressed={caption === id} onClick={() => setCaption(id)}>{label}</button>)}</div></div><div className="creator-split-copy"><span className="creator-kicker">ПО ВАШИЯ НАЧИН</span><h2>Не просто видео.<br/>Вашият почерк.</h2><p>Гласът задава тона. Лицето разказва. Субтитрите помагат всяка дума да бъде разбрана — дори без звук.</p><ul><li><Check/>Изразителни гласове с контрол на емоцията</li><li><Check/>Различни стилове, размери и позиции на субтитрите</li><li><Check/>Вертикални, квадратни и хоризонтални експорти</li><li><Check/>Готов MP4 с вградени субтитри</li></ul><Link className="btn primary" to={start}>Отворете видео студиото <ArrowUpRight size={18}/></Link></div></section>

    <section className="creator-product-section"><div className="container creator-section creator-split"><div className="creator-split-copy"><span className="creator-kicker">ВАШИЯТ ПРОДУКТ В ГЛАВНАТА РОЛЯ</span><h2>Лице. Продукт.<br/>Една обща история.</h2><p>Качете портрет и снимка на продукт. Създайте 2 или 4 варианта, изберете най-подходящия и го използвайте за говорещо видео.</p><Link className="btn dark" to="/app/media">Създайте аватар с продукт <ArrowUpRight size={18}/></Link><small>Вие избирате изображението, преди да създадете видео.</small></div><div className="creator-product-visual"><figure><img src="/images/avatars/boris.webp" alt="Примерен AI портрет за продуктова история" width="900" height="1200" loading="lazy"/><figcaption>Вашият аватар</figcaption></figure><div className="creator-product-upload"><ImagePlus size={35}/><strong>Вашият продукт</strong><span>Качете снимка.<br/>Изберете обстановка.</span><Link to="/app/media" className="btn outline small-btn"><Upload size={15}/>Добавете продукт</Link></div><span className="creator-product-plus" aria-hidden="true">+</span></div></div></section>

    <section className="container creator-section"><div className="creator-section-head"><div><span className="creator-kicker">ПЪРВО ПОСЛУШАЙТЕ</span><h2>Всяка история<br/>има своя глас.</h2></div><Link className="btn outline" to="/voices">Всички гласове <ArrowUpRight size={18}/></Link></div><div className="creator-voice-grid">{voices.slice(0,4).map(v => <VoiceCard key={v.id} voice={v}/>)}</div><p className="creator-note">Аудио примерите са от каталога с гласове. Портретите на страницата са отделни AI-генерирани илюстрации.</p></section>

    <section className="creator-pricing-section" id="plans"><div className="container creator-section"><div className="creator-center-head"><span className="creator-kicker">МЯСТО ЗА ВСЯКА ИДЕЯ</span><h2>Вашето студио.<br/>Вашият ритъм.</h2><p>Един баланс за аудио, видео и медийни инструменти.</p></div><div className="creator-plans">{plans.filter(p => p.price > 0).map(p => <article key={p.id} className={`creator-plan ${p.id === "creator" ? "featured" : ""}`}><div className="creator-plan-label"><h3>{p.name}</h3>{p.id === "creator" && <span>ЗА СЪЗДАТЕЛИ</span>}</div><p>{p.description}</p><div className="creator-price">€{p.price}<span>/ месец</span></div><Link className={`btn ${p.id === "creator" ? "primary" : "outline"}`} to={user ? "/app/billing" : `/register?plan=${p.id}`}>Изберете {p.name}<ArrowUpRight size={17}/></Link><ul>{p.features.map(f => <li key={f}><Check size={17}/>{f}</li>)}</ul></article>)}</div><div className="creator-free-note"><span><strong>Първо опитайте.</strong> 1 000 кредита за аудио проба, без банкова карта.</span><Link to={user ? "/app/billing" : "/register"}>Започнете безплатно <ArrowRight size={17}/></Link></div><Link className="creator-price-details" to="/pricing">Вижте всички тарифи, лимити и условия <ArrowUpRight size={16}/></Link></div></section>

    <section className="container creator-section creator-faq"><div><span className="creator-kicker">ДОБРЕ Е ДА ЗНАЕТЕ</span><h2>Имате въпроси?<br/>Нека ги изясним.</h2><p>Не намирате отговора?<br/><Link to="/contact">Пишете ни <ArrowUpRight size={16}/></Link></p></div><div>{questions.map(([q,a]) => <details key={q}><summary>{q}<ChevronDown size={20}/></summary><p>{a}</p></details>)}</div></section>
    <section className="container creator-final-wrap"><div className="creator-final"><span className="creator-kicker">НАПИСАНО ОТ ВАС. СЪЗДАДЕНО С РЕЧ БГ.</span><h2>Следващата история<br/>може да е вашата.</h2><Link className="btn primary" to={start}>Дайте живот на идеята си <MoveUpRight size={18}/></Link><p>Започнете с 1 000 кредита за аудио проба.</p><div className="creator-final-faces" aria-hidden="true">{portraits.map(p => <img src={p.image} alt="" width="70" height="70" loading="lazy" key={p.id}/>)}</div></div></section>
  </main>;
}
