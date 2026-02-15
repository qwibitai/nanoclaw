export const Colors = {
  // Cosmic Night palette
  backgroundDark: '#0A0A2E',
  backgroundMid: '#12124A',
  backgroundLight: '#1A1A5E',
  purple: '#6C3CE0',
  purpleLight: '#9B6DFF',
  purpleDark: '#3A1B8C',
  gold: '#FFD700',
  goldLight: '#FFE44D',
  goldDim: '#B8960F',
  moonGlow: '#FFF5CC',
  starWhite: '#FFFEF0',
  textPrimary: '#FFFFFF',
  textSecondary: '#C8C8E8',
  textMuted: '#8888BB',
  glassBorder: 'rgba(255, 255, 255, 0.15)',
  glassBackground: 'rgba(255, 255, 255, 0.08)',
  glassBackgroundLight: 'rgba(255, 255, 255, 0.12)',
  error: '#FF6B6B',
  success: '#4ECDC4',
  warning: '#FFE66D',
  overlay: 'rgba(0, 0, 0, 0.5)',
} as const;

export const Gradients = {
  cosmicNight: [Colors.backgroundDark, '#15103A', Colors.backgroundMid, '#2A1B6E'] as const,
  purpleGlow: ['#3A1B8C', '#6C3CE0', '#9B6DFF'] as const,
  goldShimmer: ['#B8960F', '#FFD700', '#FFE44D'] as const,
  glassCard: ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.05)'] as const,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const BorderRadius = {
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  full: 9999,
} as const;

export const FontFamily = {
  regular: 'Vazirmatn_400Regular',
  medium: 'Vazirmatn_500Medium',
  semiBold: 'Vazirmatn_600SemiBold',
  bold: 'Vazirmatn_700Bold',
} as const;

export const FontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
  xxl: 28,
  title: 36,
  hero: 48,
} as const;
