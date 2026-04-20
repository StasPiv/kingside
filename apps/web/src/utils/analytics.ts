const GA4_ID = import.meta.env.VITE_GA4_ID;

let initialized = false;

/* eslint-disable prefer-rest-params */
export function initGA4() {
  if (initialized || !GA4_ID) return;
  initialized = true;

  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
  script.async = true;
  document.head.appendChild(script);

  const w = window as unknown as { dataLayer: IArguments[]; gtag: (...args: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  // Standard Google gtag snippet — must use `arguments` object, not rest params
  function gtag() { w.dataLayer.push(arguments as unknown as IArguments); }
  w.gtag = gtag as unknown as typeof w.gtag;
  // Invoke via the typed alias so TS accepts the variadic arguments.
  w.gtag('js', new Date());
  w.gtag('config', GA4_ID);
}

export function trackEvent(name: string, params?: Record<string, unknown>) {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (gtag) gtag('event', name, params);
}
