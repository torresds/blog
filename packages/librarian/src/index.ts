export const SUPPORTED_LOCALES = ['pt-BR', 'en-US'] as const;
export type LibrarianLocale = (typeof SUPPORTED_LOCALES)[number];
