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
const SERVER_VOICE_KEY = 'collaborator_server_voice';
const END_WORD_KEY = 'collaborator_end_word';
const STOP_WORD_KEY = 'collaborator_stop_word';
const END_PHRASE_KEY = 'collaborator_end_phrase';
const INTERRUPT_PHRASE_KEY = 'collaborator_interrupt_phrase';
const STT_KEY = 'collaborator_stt_engine';
const RECALL_KEY = 'collaborator_recall';

export const DEFAULT_END_WORD = 'go';
export const DEFAULT_STOP_WORD = 'stop';
// Server phrase tier (free text, matched in the ASR transcript). Guidance:
// 2-4 words, phonetically distinctive, nothing you'd say while dictating.
export const DEFAULT_END_PHRASE = 'that is all';
export const DEFAULT_INTERRUPT_PHRASE = 'hold on';

export type TtsEngine = 'server' | 'piper' | 'browser';
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
  const v = read(ENGINE_KEY);
  return v === 'browser' || v === 'server' ? v : 'piper';
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

// --- Server TTS voice ('' = let the server pick its default) ---
export function getServerVoice(): string {
  return read(SERVER_VOICE_KEY) ?? '';
}
export function setServerVoice(value: string): void {
  write(SERVER_VOICE_KEY, value);
}
export function useServerVoice(): string {
  return useSyncExternalStore(subscribe, getServerVoice, () => '');
}

// --- Voice command phrases (server phrase detection in the ASR stream) ---
export function getEndPhrase(): string {
  return read(END_PHRASE_KEY)?.trim() || DEFAULT_END_PHRASE;
}
export function setEndPhrase(value: string): void {
  write(END_PHRASE_KEY, value);
}
export function useEndPhrase(): string {
  return useSyncExternalStore(subscribe, getEndPhrase, () => DEFAULT_END_PHRASE);
}

export function getInterruptPhrase(): string {
  return read(INTERRUPT_PHRASE_KEY)?.trim() || DEFAULT_INTERRUPT_PHRASE;
}
export function setInterruptPhrase(value: string): void {
  write(INTERRUPT_PHRASE_KEY, value);
}
export function useInterruptPhrase(): string {
  return useSyncExternalStore(
    subscribe,
    getInterruptPhrase,
    () => DEFAULT_INTERRUPT_PHRASE,
  );
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
