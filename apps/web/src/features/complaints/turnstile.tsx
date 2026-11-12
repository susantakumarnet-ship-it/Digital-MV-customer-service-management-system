import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; 'expired-callback'?: () => void }) => string;
      remove?: (id: string) => void;
    };
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;
function loadScript() {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the verification widget'));
    document.head.appendChild(s);
  });
  return loading;
}

/** Cloudflare Turnstile widget, rendered only when a site key is configured (D-32). */
export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string | undefined) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let id: string | undefined;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, { sitekey: siteKey, callback: (t) => onToken(t), 'expired-callback': () => onToken(undefined) });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove?.(id);
    };
  }, [siteKey, onToken]);
  return (
    <div>
      <div ref={ref} />
      {error && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
