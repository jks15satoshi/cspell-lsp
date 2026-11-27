import type { CSpellUserSettings } from 'cspell-lib';

/**
 * Creates settings for a new workspace config file without sharing mutable
 * state with the initialization defaults.
 *
 * `words` and `userWords` are copied because adding a word and sorting mutate
 * them in place. Other values are copied shallowly; initialization defaults
 * come from JSON and do not need deeper cloning.
 */
export function cloneSettingsForConfig(
  settings: CSpellUserSettings,
): CSpellUserSettings {
  const clone: CSpellUserSettings = { ...settings };
  if (settings.words) clone.words = [...settings.words];
  if (settings.userWords) clone.userWords = [...settings.userWords];
  return clone;
}
