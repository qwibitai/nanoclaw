export interface UserProfile {
  id: string;
  fullName: string;
  dateOfBirth: {
    day: number;
    month: number;
    year: number;
  };
  timeOfBirth?: string; // HH:MM format, optional
  gender: 'male' | 'female' | 'other';
  maritalStatus: 'single' | 'married' | 'divorced' | 'widowed';
  createdAt: number;
}

export interface DreamInterpretation {
  id: string;
  dreamText: string;
  meaning: string;
  warning: string;
  goodNews: string;
  timestamp: number;
}

export interface HoroscopeReading {
  sign: string;
  kurdishSign: string;
  daily: string;
  date: string;
}

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Dream: undefined;
  Horoscope: undefined;
  Profile: undefined;
};
