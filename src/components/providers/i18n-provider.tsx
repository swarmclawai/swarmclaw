'use client';

import { ReactNode, useEffect } from 'react';
import initializeI18n from '@/i18n';

export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    initializeI18n();
  }, []);

  return <>{children}</>;
}
