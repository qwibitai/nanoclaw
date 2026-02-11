import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Audio } from 'expo-av';

interface AudioContextType {
  isMuted: boolean;
  toggleMute: () => void;
}

const AudioCtx = createContext<AudioContextType>({ isMuted: false, toggleMute: () => {} });

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isMuted, setIsMuted] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadAudio = async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });

        const { sound } = await Audio.Sound.createAsync(
          // Placeholder: replace with actual ambient audio asset
          require('../../assets/audio/ambient.mp3'),
          {
            isLooping: true,
            volume: 0.3,
            shouldPlay: true,
          }
        );

        if (mounted) {
          soundRef.current = sound;
        } else {
          await sound.unloadAsync();
        }
      } catch (error) {
        // Audio file not found - silently continue
        console.log('Background audio not available:', error);
      }
    };

    loadAudio();

    return () => {
      mounted = false;
      soundRef.current?.unloadAsync();
    };
  }, []);

  useEffect(() => {
    if (soundRef.current) {
      if (isMuted) {
        soundRef.current.setVolumeAsync(0);
      } else {
        soundRef.current.setVolumeAsync(0.3);
      }
    }
  }, [isMuted]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  return (
    <AudioCtx.Provider value={{ isMuted, toggleMute }}>
      {children}
    </AudioCtx.Provider>
  );
};

export function useAudio(): AudioContextType {
  return useContext(AudioCtx);
}
