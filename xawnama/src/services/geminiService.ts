import { GoogleGenerativeAI } from '@google/generative-ai';
import Constants from 'expo-constants';

const API_KEY = Constants.expirationDate
  ? 'PLACEHOLDER'
  : (Constants.expoConfig?.extra?.geminiApiKey ?? 'YOUR_GEMINI_API_KEY');

const genAI = new GoogleGenerativeAI(API_KEY);

const DREAM_SYSTEM_PROMPT = `You are a wise, poetic Kurdish elder. Interpret this dream in 'Sorani Kurdish'. Use sweet, mystical language. Provide the interpretation in 3 parts:

**واتا (The Meaning):** Explain the dream's symbolic meaning deeply.
**ئاگاداری (The Warning):** Provide any cautionary message from the dream.
**مژدە (The Good News):** Share the positive message or blessing in the dream.

Always respond in Sorani Kurdish using Arabic script. Be poetic and mystical in your language.`;

const HOROSCOPE_SYSTEM_PROMPT = `You are a mystical Kurdish astrologer. Provide a daily horoscope reading in Sorani Kurdish. Be poetic, encouraging, and mystical. Keep it between 3-5 sentences. Always respond in Sorani Kurdish using Arabic script.`;

export async function interpretDream(dreamText: string): Promise<{
  meaning: string;
  warning: string;
  goodNews: string;
}> {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: DREAM_SYSTEM_PROMPT },
            { text: `خەونەکەم ئەمە بوو: ${dreamText}` },
          ],
        },
      ],
    });

    const response = result.response.text();

    // Parse the three sections from the response
    const meaningMatch = response.match(/واتا[^:]*:([\s\S]*?)(?=ئاگاداری|$)/);
    const warningMatch = response.match(/ئاگاداری[^:]*:([\s\S]*?)(?=مژدە|$)/);
    const goodNewsMatch = response.match(/مژدە[^:]*:([\s\S]*?)$/);

    return {
      meaning: meaningMatch?.[1]?.trim() || response,
      warning: warningMatch?.[1]?.trim() || 'هیچ ئاگاداریەک نییە',
      goodNews: goodNewsMatch?.[1]?.trim() || 'خوا لەگەڵتدایە',
    };
  } catch (error) {
    console.error('Gemini dream interpretation error:', error);
    throw new Error('نەتوانرا خەونەکە لێکبدرێتەوە. تکایە دووبارە هەوڵبدەوە.');
  }
}

export async function getDailyHoroscope(
  signName: string,
  kurdishSignName: string
): Promise<string> {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: HOROSCOPE_SYSTEM_PROMPT },
            {
              text: `فاڵی ڕۆژانەی بۆ هێمای بورج "${kurdishSignName}" (${signName}) بۆ ئەمڕۆ بنووسە.`,
            },
          ],
        },
      ],
    });

    return result.response.text();
  } catch (error) {
    console.error('Gemini horoscope error:', error);
    throw new Error('نەتوانرا فاڵەکە بهێنرێت. تکایە دووبارە هەوڵبدەوە.');
  }
}
