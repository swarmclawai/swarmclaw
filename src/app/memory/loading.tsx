'use client'

import { useTranslation } from 'react-i18next';
import { PageLoader } from '@/components/ui/page-loader'

export default function Loading() {
  const { t } = useTranslation()
  return <PageLoader label={t('loadingMemory')} />
}
