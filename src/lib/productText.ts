import { useT } from './i18n.ts';
/** Product-specific keys use the same reactive locale selection as inherited UI. */
export function useProductText() { return useT(); }
