export const mobile = location.hostname === "m.youtube.com";
const selector = mobile ? "ytm-app" : "ytd-app";
type AppConsumer = (root: Element, signal: AbortSignal) => void;
const consumers = new Set<AppConsumer>();
let root: Element | null = null;
let lifetime: AbortController | undefined;
let observer: MutationObserver | undefined;

export function ready(run: () => void): void {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

export function observeAppTree(
  observer: MutationObserver,
  root: Element | null,
): void {
  observer.disconnect();
  if (!root?.parentNode)
    observer.observe(document, { childList: true, subtree: true });
  for (let parent = root?.parentNode; parent; parent = parent.parentNode)
    observer.observe(parent, { childList: true });
}

function syncApp(): void {
  const next = root?.isConnected ? root : document.querySelector(selector);
  if (root === next) {
    if (root && observer) observeAppTree(observer, root);
    return;
  }
  lifetime?.abort();
  root = next;
  lifetime = next ? new AbortController() : undefined;
  if (observer) observeAppTree(observer, root);
  if (next && lifetime) for (const run of consumers) run(next, lifetime.signal);
}

export function app(run: AppConsumer): void {
  if (!observer) {
    observer = new MutationObserver(syncApp);
    root = document.querySelector(selector);
    if (root) lifetime = new AbortController();
    observeAppTree(observer, root);
  }
  consumers.add(run);
  if (root && lifetime) run(root, lifetime.signal);
}

export function navigation(run: () => void, signal: AbortSignal): void {
  if (mobile) {
    for (const event of ["state-navigateend", "updateui", "popstate"])
      window.addEventListener(event, run, { signal });
  } else {
    for (const event of ["yt-navigate-finish", "yt-page-type-changed"])
      document.addEventListener(event, run, { capture: true, signal });
    window.addEventListener("popstate", run, { signal });
  }
}

export function visible(element: Element): boolean {
  return (
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

export function svg(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const graphic = document.createElementNS(ns, "svg");
  graphic.setAttribute("viewBox", "0 0 24 24");
  graphic.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  graphic.append(shape);
  return graphic;
}

export function activation(
  button: HTMLButtonElement,
  action: () => void,
): void {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) action();
  });
}
