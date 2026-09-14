import { useSyncExternalStore } from 'react';
import { hybridVoiceState, subscribeHybridVoice } from './voice-client';

export function useHybridVoice() {
  return useSyncExternalStore(subscribeHybridVoice, hybridVoiceState, hybridVoiceState);
}
