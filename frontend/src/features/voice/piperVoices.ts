import type { VoiceId } from '@diffusionstudio/vits-web';

/** Curated English Piper voices offered in Settings. (vits-web has ~120 total.) */
export const PIPER_VOICES: { id: VoiceId; label: string }[] = [
  { id: 'en_US-amy-medium', label: 'Amy (US) — medium' },
  { id: 'en_US-amy-low', label: 'Amy (US) — low (faster)' },
  { id: 'en_US-hfc_female-medium', label: 'HFC Female (US) — medium' },
  { id: 'en_US-hfc_male-medium', label: 'HFC Male (US) — medium' },
  { id: 'en_US-lessac-medium', label: 'Lessac (US) — medium' },
  { id: 'en_US-lessac-high', label: 'Lessac (US) — high (slower)' },
  { id: 'en_US-ryan-medium', label: 'Ryan (US) — medium' },
  { id: 'en_US-ryan-high', label: 'Ryan (US) — high (slower)' },
  { id: 'en_US-libritts_r-medium', label: 'LibriTTS-R (US) — medium' },
  { id: 'en_US-kristin-medium', label: 'Kristin (US) — medium' },
  { id: 'en_US-joe-medium', label: 'Joe (US) — medium' },
  { id: 'en_GB-alan-medium', label: 'Alan (GB) — medium' },
  { id: 'en_GB-alba-medium', label: 'Alba (GB) — medium' },
  { id: 'en_GB-cori-high', label: 'Cori (GB) — high (slower)' },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny (GB) — medium' },
  {
    id: 'en_GB-northern_english_male-medium',
    label: 'Northern English Male (GB) — medium',
  },
];

export const DEFAULT_PIPER_VOICE: VoiceId = 'en_US-amy-medium';
