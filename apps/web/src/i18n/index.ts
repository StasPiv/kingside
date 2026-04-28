import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';
// KS-2066 (F0/ADR-033): отдельный namespace `archive` под раздел архива.
// Ключи рендерятся через `t('archive:lobby.title')` или
// `useTranslation('archive')` + `t('lobby.title')`.
import enArchive from './locales/en/archive.json';
import ruArchive from './locales/ru/archive.json';

// Languages mapped to Russian (CIS / post-Soviet countries)
const RU_LANGS = new Set(['ru', 'uk', 'be', 'kk', 'uz', 'ky', 'tg', 'az', 'ka', 'hy']);

const cached = localStorage.getItem('locale');
const browserLang = navigator.language.split('-')[0];
const detected = RU_LANGS.has(browserLang) ? 'ru' : 'en';
const lng = cached === 'ru' || cached === 'en' ? cached : detected;

console.log('[i18n] navigator.language:', navigator.language, '| browserLang:', browserLang, '| cached:', cached, '| detected:', detected, '| chosen:', lng);

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en, archive: enArchive },
    ru: { translation: ru, archive: ruArchive },
  },
  // KS-2066: namespace `archive` подключён, но defaultNS остаётся
  // `translation`, чтобы существующий код `t('lessons.title')` без
  // ns-префикса продолжал работать.
  ns: ['translation', 'archive'],
  defaultNS: 'translation',
  lng,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
