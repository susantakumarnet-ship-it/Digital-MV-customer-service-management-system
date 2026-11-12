import type { ReactNode } from 'react';
import { ClipboardCheck, MapPin, ShieldCheck } from 'lucide-react';
import { usePublicSettings } from '@/lib/queries';

export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#0b1f4b" />
      <path d="M8 22V10l5 7 5-7v12" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23.5" cy="21" r="2.5" fill="#14b8a6" />
    </svg>
  );
}

/** Two-panel layout for sign-in screens; collapses to a single column on phones. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { data: settings } = usePublicSettings();
  const appName = settings?.applicationName ?? 'Digital MV Customer Service Management System';
  return (
    <div className="flex min-h-full">
      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden bg-navy-900 p-10 text-white lg:flex">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-royal-700/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-teal-600/25 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <BrandMark className="h-10 w-10" />
          <span className="text-lg font-semibold">Digital MV</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight text-white">{appName}</h2>
          <p className="mt-3 text-navy-200">
            From complaint registration to field service, inspection, approval and customer acceptance — in one auditable platform.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-navy-100">
            <li className="flex items-center gap-3">
              <ClipboardCheck className="h-5 w-5 text-teal-500" aria-hidden /> Complaint-to-closure lifecycle
            </li>
            <li className="flex items-center gap-3">
              <MapPin className="h-5 w-5 text-teal-500" aria-hidden /> Field visits with six-step time tracking
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-teal-500" aria-hidden /> Role-based access and full audit trail
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-navy-300">{settings?.organizationName || ' '}</p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <span className="font-semibold text-navy-900">Digital MV CSMS</span>
          </div>
          <h1 className="text-2xl font-semibold text-navy-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
