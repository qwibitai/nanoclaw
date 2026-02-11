export type SupportedLanguage = 'mr' | 'hi' | 'en';

const SUPPORTED_LANGUAGES: SupportedLanguage[] = ['mr', 'hi', 'en'];

export function getPreferredLanguage(
  phone: string,
  getLanguageByPhone: (phone: string) => string | undefined,
): SupportedLanguage | null {
  try {
    const language = getLanguageByPhone(phone);
    if (language && SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)) {
      return language as SupportedLanguage;
    }
  } catch {
    // Best-effort lookup; caller can fall back to message-based detection.
  }
  return null;
}

export function detectLanguageFromText(text: string): SupportedLanguage {
  if (/[A-Za-z]/.test(text)) return 'en';
  if (/[\u0900-\u097F]/.test(text)) return 'mr';
  return 'mr';
}

export function getFallbackErrorMessage(language: SupportedLanguage): string {
  if (language === 'hi') {
    return 'तकनीकी समस्या के कारण आपका संदेश प्रोसेस नहीं हो सका। कृपया फिर से प्रयास करें।';
  }
  if (language === 'en') {
    return 'Your message could not be processed due to a technical issue. Please try again.';
  }
  return 'तांत्रिक अडचणीमुळे तुमचा संदेश प्रक्रिया होऊ शकला नाही. कृपया पुन्हा प्रयत्न करा.';
}
