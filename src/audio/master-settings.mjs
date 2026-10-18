import { ExportError } from '../export/wav.mjs';

export const DEFAULT_MASTER_SETTINGS = Object.freeze({ gainDb: 0, balance: 0, low: 0, mid: 0, high: 0, highpass: 0, compression: 0, normalize: false, ceilingDb: -1 });
export const MASTER_RANGES = Object.freeze({ gainDb: [-24, 24], balance: [-1, 1], low: [-18, 18], mid: [-18, 18], high: [-18, 18], highpass: [0, 2000], compression: [0, 1], ceilingDb: [-12, 0] });

/** Shared validation for the project, renderer, and portable recording metadata. */
export function normalizeMasterSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ExportError('INVALID_MASTER', 'The recording sound settings are invalid.');
  const settings = { ...DEFAULT_MASTER_SETTINGS };
  for (const [key, [minimum, maximum]] of Object.entries(MASTER_RANGES)) {
    const value = input[key] === undefined ? settings[key] : input[key];
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new ExportError('INVALID_MASTER', `The ${key} setting must be between ${minimum} and ${maximum}.`);
    settings[key] = value;
  }
  if (input.normalize !== undefined && typeof input.normalize !== 'boolean') throw new ExportError('INVALID_MASTER', 'Peak normalization must be on or off.');
  settings.normalize = input.normalize ?? settings.normalize;
  return settings;
}
