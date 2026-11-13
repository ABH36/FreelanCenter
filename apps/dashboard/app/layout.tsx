import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { BRAND_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: { default: BRAND_NAME, template: `%s · ${BRAND_NAME}` },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
