import { Children, isValidElement, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import "./creator-motion.css";

// Preserve word wrapping and one accessible text label while animating letters.
function textOf(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return child.type === "br" ? " " : textOf(child.props.children);
    return "";
  }).join("");
}
function letters(children: ReactNode, reverse = false, counter = { value: 0 }): ReactNode {
  const total = Array.from(textOf(children).replace(/\s/g, "")).length;
  return Children.map(children, child => {
    if (typeof child !== "string" && typeof child !== "number") return child;
    return String(child).split(/(\s+)/).map((word, w) => /^\s+$/.test(word) ? word :
      <span className="motion-word" key={w}>{Array.from(word).map(char => {
        const index = counter.value++;
        return <span className="motion-char" key={index} style={{ "--letter": reverse ? total - index - 1 : index } as CSSProperties}>{char}</span>;
      })}</span>);
  });
}
export function MotionHeading({ children, as: Tag = "h2" }: { children: ReactNode; as?: "h1" | "h2" }) {
  return <Tag className="motion-heading" aria-label={textOf(children)}><span aria-hidden="true">{letters(children)}</span></Tag>;
}
export function WaveLabel({ children }: { children: string }) {
  return <span className="motion-button-label"><span className="motion-sr-only">{children}</span><span aria-hidden="true">{letters(children, true)}</span></span>;
}
export function ImageReveal() {
  return <span className="motion-image-mask" aria-hidden="true">{Array.from({length: 9}, (_, i) => <i key={i} />)}</span>;
}

// RUBOZ timings: 0.5s letters / 0.03s stagger, 0.6s entrance / 0.1s group
// stagger, image diagonals 0.125s apart. Native animation keeps React ownership.
export function useCreatorMotion() {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const page = root.current;
    if (!page || !window.IntersectionObserver || !Element.prototype.animate) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let teardown = () => {};
    const setup = () => {
      teardown();
      if (preference.matches) return;
      const pending = new Map<Element, Animation[]>();
      const active = new Set<Animation>();
      const observe = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          pending.get(entry.target)?.forEach(a => a.play());
          pending.delete(entry.target);
          observe.unobserve(entry.target);
        });
      }, { rootMargin: "0px 0px -10% 0px", threshold: 0 });
      const add = (trigger: Element, target: Element, frames: Keyframe[], duration: number, delay = 0) => {
        const a = target.animate(frames, { duration, delay, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" });
        a.pause();
        active.add(a);
        a.onfinish = () => { active.delete(a); a.cancel(); };
        pending.set(trigger, [...(pending.get(trigger) || []), a]);
        observe.observe(trigger);
      };
      page.querySelectorAll(".motion-heading").forEach(heading => {
        heading.querySelectorAll(".motion-char").forEach((char, i) => add(heading, char, [
          { transform: "translateY(50%) scaleY(0)", opacity: 0, filter: "blur(6px)" },
          { transform: "translateY(0) scaleY(1)", opacity: 1, filter: "blur(0)" },
        ], 500, 200 + i * 30));
      });
      const entrance = (el: Element, delay = 0, x = 0, y = 50) => add(el, el, [
        { translate: `${x}px ${y}px`, opacity: 0, filter: "blur(10px)" },
        { translate: "0px 0px", opacity: 1, filter: "blur(0)" },
      ], 600, delay);
      page.querySelectorAll(".creator-tools, .creator-steps, .creator-plans, .creator-voice-grid").forEach(group => {
        Array.from(group.children).forEach((el, i) => entrance(el, i * 100));
      });
      page.querySelectorAll(".creator-kicker, .creator-hero-copy > p, .creator-actions, .creator-proof, .creator-platforms, .creator-section-head > p, .creator-split-copy > p, .creator-split-copy > ul, .creator-split-copy > .btn, .creator-faq details, .creator-final > .btn").forEach(el => entrance(el, 100));
      const hero = page.querySelector(".creator-showcase");
      if (hero) entrance(hero, 500, -50, 0);
      page.querySelectorAll(".motion-image-mask").forEach(mask => {
        Array.from(mask.children).forEach((tile, i) => add(mask, tile, [
          { clipPath: "polygon(0 0,100% 0,100% 100%,0 100%)" },
          { clipPath: "polygon(100% 100%,100% 100%,100% 100%,100% 100%)" },
        ], 1000, (Math.floor(i / 3) + i % 3) * 125));
      });
      // Keyboard users must never tab into invisible, not-yet-revealed controls.
      const revealFocus = (event: FocusEvent) => {
        if (!(event.target instanceof Element)) return;
        pending.forEach((animations, el) => {
          if (!el.contains(event.target as Element)) return;
          animations.forEach(a => { active.delete(a); a.cancel(); });
          pending.delete(el);
          observe.unobserve(el);
        });
      };
      page.addEventListener("focusin", revealFocus);
      teardown = () => {
        observe.disconnect();
        active.forEach(a => a.cancel());
        pending.clear();
        page.removeEventListener("focusin", revealFocus);
      };
    };
    setup();
    preference.addEventListener("change", setup);
    return () => { teardown(); preference.removeEventListener("change", setup); };
  }, []);
  return root;
}
