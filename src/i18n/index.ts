import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';

const initializeI18n = () => {
  if (typeof window !== 'undefined' && !i18n.isInitialized) {
    i18n
      .use(LanguageDetector)
      .use(initReactI18next)
      .init({
        resources: {
          'zh-CN': { translation: zhCN },
          en: { translation: en },
        },
        fallbackLng: 'en',
        interpolation: {
          escapeValue: false,
        },
      });
  }
  return i18n;
};

export default initializeI18n;
