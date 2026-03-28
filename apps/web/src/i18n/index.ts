import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

// Languages mapped to Russian (CIS / post-Soviet countries)
const RU_LANGS = new Set(['ru', 'uk', 'be', 'kk', 'uz', 'ky', 'tg', 'az', 'ka', 'hy']);

const cached = localStorage.getItem('locale');
const browserLang = navigator.language.split('-')[0];
const detected = RU_LANGS.has(browserLang) ? 'ru' : 'en';
const lng = cached === 'ru' || cached === 'en' ? cached : detected;

console.log('[i18n] navigator.language:', navigator.language, '| browserLang:', browserLang, '| cached:', cached, '| detected:', detected, '| chosen:', lng);

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
