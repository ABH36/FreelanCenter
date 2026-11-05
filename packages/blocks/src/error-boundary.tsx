'use client';

/**
 * Client-side block boundary for interactive trees (the builder's live preview, P3), where React does catch render
 * errors. Server rendering is isolated by `renderSection` instead (see render.tsx). Reports a safe summary only.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly onError?: (summary: string) => void;
}

export class BlockErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    try {
      this.props.onError?.(`Block render failed (${error.name})`);
    } catch {
      // never let reporting break the page
    }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
