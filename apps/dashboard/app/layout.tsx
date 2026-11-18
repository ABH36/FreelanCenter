import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { StaleBuildGuard } from '@/components/stale-build-guard';
import { BRAND_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: { default: BRAND_NAME, template: `%s · ${BRAND_NAME}` },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* P3 S9a (DG-39 (b)): asks for a reload when a deployment replaced the build this page came from. */}
        <StaleBuildGuard />
      </body>
    </html>
  );
}
