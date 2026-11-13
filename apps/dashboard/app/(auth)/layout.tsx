import type { ReactNode } from 'react';
import { BRAND_NAME } from '@/lib/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-surface)] px-4 py-12">
      <div className="mb-8 flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-md bg-[var(--color-primary)] text-white">
          F
        </span>
        {BRAND_NAME}
      </div>
      {children}
    </main>
  );
}
