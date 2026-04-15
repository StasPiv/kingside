const GA4_ID = import.meta.env.VITE_GA4_ID;

let initialized = false;

export function initGA4() {
  if (initialized || !GA4_ID) return;
  initialized = true;

  const script = document.createElement('script');
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
  script.async = true;
  document.head.appendChild(script);

  (window as unknown as { dataLayer: unknown[] }).dataLayer = (window as unknown as { dataLayer: unknown[] }).dataLayer || [];
  function gtag(...args: unknown[]) {
    (window as unknown as { dataLayer: unknown[] }).dataLayer.push(args);
  }
  gtag('js', new Date());
  gtag('config', GA4_ID);

  (window as unknown as { gtag: typeof gtag }).gtag = gtag;
}

export function trackEvent(name: string, params?: Record<string, unknown>) {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (gtag) gtag('event', name, params);
}
