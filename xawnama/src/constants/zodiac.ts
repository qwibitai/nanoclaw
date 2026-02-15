export interface ZodiacSign {
  name: string;
  kurdishName: string;
  symbol: string;
  dateRange: string;
  element: string;
}

export const ZODIAC_SIGNS: ZodiacSign[] = [
  { name: 'Aries', kurdishName: 'بەران', symbol: '♈', dateRange: '٢١ ئازار - ١٩ نیسان', element: 'ئاگر' },
  { name: 'Taurus', kurdishName: 'گا', symbol: '♉', dateRange: '٢٠ نیسان - ٢٠ ئایار', element: 'خاک' },
  { name: 'Gemini', kurdishName: 'دووانە', symbol: '♊', dateRange: '٢١ ئایار - ٢٠ حوزەیران', element: 'با' },
  { name: 'Cancer', kurdishName: 'قیژوک', symbol: '♋', dateRange: '٢١ حوزەیران - ٢٢ تەممووز', element: 'ئاو' },
  { name: 'Leo', kurdishName: 'شێر', symbol: '♌', dateRange: '٢٣ تەممووز - ٢٢ ئاب', element: 'ئاگر' },
  { name: 'Virgo', kurdishName: 'کچ', symbol: '♍', dateRange: '٢٣ ئاب - ٢٢ ئەیلوول', element: 'خاک' },
  { name: 'Libra', kurdishName: 'تەرازوو', symbol: '♎', dateRange: '٢٣ ئەیلوول - ٢٢ تشرینی یەکەم', element: 'با' },
  { name: 'Scorpio', kurdishName: 'دووپشک', symbol: '♏', dateRange: '٢٣ تشرینی یەکەم - ٢١ تشرینی دووەم', element: 'ئاو' },
  { name: 'Sagittarius', kurdishName: 'تیرئاوەنت', symbol: '♐', dateRange: '٢٢ تشرینی دووەم - ٢١ کانوونی یەکەم', element: 'ئاگر' },
  { name: 'Capricorn', kurdishName: 'بزن', symbol: '♑', dateRange: '٢٢ کانوونی یەکەم - ١٩ کانوونی دووەم', element: 'خاک' },
  { name: 'Aquarius', kurdishName: 'سەتڵ', symbol: '♒', dateRange: '٢٠ کانوونی دووەم - ١٨ شوبات', element: 'با' },
  { name: 'Pisces', kurdishName: 'ماسی', symbol: '♓', dateRange: '١٩ شوبات - ٢٠ ئازار', element: 'ئاو' },
];

export interface ChineseZodiac {
  name: string;
  kurdishName: string;
  emoji: string;
  traits: string;
}

export const CHINESE_ZODIAC: ChineseZodiac[] = [
  { name: 'Rat', kurdishName: 'مشک', emoji: '🐀', traits: 'زیرەک، وریا، سەرکەوتوو لە کار و بار' },
  { name: 'Ox', kurdishName: 'گا', emoji: '🐂', traits: 'بەهێز، دڵسۆز، جێگیر و متمانەپێکراو' },
  { name: 'Tiger', kurdishName: 'پڵنگ', emoji: '🐅', traits: 'ئازا، بوێر، سەرکردە و پڕ وزە' },
  { name: 'Rabbit', kurdishName: 'کەروێشک', emoji: '🐇', traits: 'نەرم، هونەرمەند، ئاشتیخواز' },
  { name: 'Dragon', kurdishName: 'ئەژدەها', emoji: '🐉', traits: 'بەهێز، بەختیار، سەرکردایەتی' },
  { name: 'Snake', kurdishName: 'مار', emoji: '🐍', traits: 'دانا، نهێنیخواز، وریا' },
  { name: 'Horse', kurdishName: 'ئەسپ', emoji: '🐎', traits: 'چالاک، خۆشحاڵ، ئازاد' },
  { name: 'Goat', kurdishName: 'بزن', emoji: '🐐', traits: 'ئارام، هونەرمەند، دڵۆڤان' },
  { name: 'Monkey', kurdishName: 'مەیموون', emoji: '🐒', traits: 'زیرەک، خۆشگوزەران، داھێنەر' },
  { name: 'Rooster', kurdishName: 'کەڵەشێر', emoji: '🐓', traits: 'ڕاستگۆ، وریا، کاراریگەر' },
  { name: 'Dog', kurdishName: 'سەگ', emoji: '🐕', traits: 'دڵسۆز، ڕاستگۆ، پارێزەر' },
  { name: 'Pig', kurdishName: 'بەراز', emoji: '🐖', traits: 'دڵۆڤان، بەخشندە، دەوڵەمەند' },
];

export function getZodiacSign(month: number, day: number): ZodiacSign {
  const dates: [number, number][] = [
    [1, 20], [2, 19], [3, 21], [4, 20], [5, 21], [6, 21],
    [7, 23], [8, 23], [9, 23], [10, 23], [11, 22], [12, 22],
  ];
  let index = month - 1;
  if (day < dates[index][1]) {
    index = (index + 11) % 12;
  }
  return ZODIAC_SIGNS[index];
}

export function getChineseZodiac(year: number): ChineseZodiac {
  const index = (year - 4) % 12;
  return CHINESE_ZODIAC[index >= 0 ? index : index + 12];
}
