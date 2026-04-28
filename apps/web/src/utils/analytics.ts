const GA4_ID = import.meta.env.VITE_GA4_ID;

let initialized = false;

export function initGA4() {
  if (initialized || !GA4_ID) return;
  initialized = true;

  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
  script.async = true;
  document.head.appendChild(script);

  const w = window as unknown as { dataLayer: IArguments[]; gtag: (...args: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  // KS-2034: стандартный Google gtag snippet требует `arguments`-объект,
  // не rest params (gtag.js обращается к `arguments` по форме).
  // Поэтому prefer-rest-params для этой функции отключён осознанно.
  // eslint-disable-next-line prefer-rest-params
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
