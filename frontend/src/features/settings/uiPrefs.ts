import { useSyncExternalStore } from 'react';
import {
  DEFAULT_PIPER_VOICE,
  PIPER_VOICES,
} from '@/features/voice/piperVoices';

/**
 * Client-side UI preferences (localStorage), separate from backend settings:
 * the developer diagnostics toggle, the TTS engine, and the Piper voice.
 */
const DEBUG_KEY = 'collaborator_debug';
const ENGINE_KEY = 'collaborator_tts_engine';
const VOICE_KEY = 'collaborator_piper_voice';
const END_WORD_KEY = 'collaborator_end_word';
const STOP_WORD_KEY = 'collaborator_stop_word';
const STT_KEY = 'collaborator_stt_engine';
const RECALL_KEY = 'collaborator_recall';

export const DEFAULT_END_WORD = 'go';
export const DEFAULT_STOP_WORD = 'stop';

export type TtsEngine = 'piper' | 'browser';
export type SttEngine = 'server' | 'device';

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  listeners.forEach((l) => l());
}
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  notify();
}

// --- Developer diagnostics ---
export function getDebugEnabled(): boolean {
  return read(DEBUG_KEY) === '1';
}
export function setDebugEnabled(value: boolean): void {
  write(DEBUG_KEY, value ? '1' : '0');
}
export function useDebugEnabled(): boolean {
  return useSyncExternalStore(subscribe, getDebugEnabled, () => false);
}

// --- TTS engine ---
export function getTtsEngine(): TtsEngine {
  return read(ENGINE_KEY) === 'browser' ? 'browser' : 'piper';
}
export function setTtsEngine(value: TtsEngine): void {
  write(ENGINE_KEY, value);
}
export function useTtsEngine(): TtsEngine {
  return useSyncExternalStore(subscribe, getTtsEngine, () => 'piper');
}

// --- Recall (memory): inject synthesized memories into context (opt-in) ---
export function getRecallEnabled(): boolean {
  return read(RECALL_KEY) === '1';
}
export function setRecallEnabled(value: boolean): void {
  write(RECALL_KEY, value ? '1' : '0');
}
export function useRecallEnabled(): boolean {
  return useSyncExternalStore(subscribe, getRecallEnabled, () => false);
}

// --- Speech-to-text engine (server Whisper vs on-device Transformers.js) ---
export function getSttEngine(): SttEngine {
  return read(STT_KEY) === 'device' ? 'device' : 'server';
}
export function setSttEngine(value: SttEngine): void {
  write(STT_KEY, value);
}
export function useSttEngine(): SttEngine {
  return useSyncExternalStore(subscribe, getSttEngine, () => 'server');
}

// --- Piper voice ---
const VALID_VOICE_IDS = new Set(PIPER_VOICES.map((v) => v.id));
export function getPiperVoice(): string {
  const v = read(VOICE_KEY);
  return v && VALID_VOICE_IDS.has(v as never) ? v : DEFAULT_PIPER_VOICE;
}
export function setPiperVoice(value: string): void {
  write(VOICE_KEY, value);
}
export function usePiperVoice(): string {
  return useSyncExternalStore(subscribe, getPiperVoice, () => DEFAULT_PIPER_VOICE);
}

// --- Voice command words (on-device keyword spotting, fixed vocabulary) ---
export function getEndWord(): string {
  return read(END_WORD_KEY) || DEFAULT_END_WORD;
}
export function setEndWord(value: string): void {
  write(END_WORD_KEY, value);
}
export function useEndWord(): string {
  return useSyncExternalStore(subscribe, getEndWord, () => DEFAULT_END_WORD);
}

export function getStopWord(): string {
  return read(STOP_WORD_KEY) || DEFAULT_STOP_WORD;
}
export function setStopWord(value: string): void {
  write(STOP_WORD_KEY, value);
}
export function useStopWord(): string {
  return useSyncExternalStore(subscribe, getStopWord, () => DEFAULT_STOP_WORD);
}
