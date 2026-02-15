import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import StarBackground from '../components/StarBackground';
import GlassPanel from '../components/GlassPanel';
import CosmicButton from '../components/CosmicButton';
import { useAuth } from '../context/AuthContext';
import { getZodiacSign, getChineseZodiac, ZODIAC_SIGNS } from '../constants/zodiac';
import { getDailyHoroscope } from '../services/geminiService';
import {
  Colors,
  FontFamily,
  FontSize,
  Spacing,
  BorderRadius,
} from '../constants/theme';

export default function HoroscopeScreen() {
  const { user } = useAuth();
  const [horoscope, setHoroscope] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const zodiac = user
    ? getZodiacSign(user.dateOfBirth.month, user.dateOfBirth.day)
    : null;
  const chinese = user ? getChineseZodiac(user.dateOfBirth.year) : null;

  const fetchHoroscope = useCallback(async () => {
    if (!zodiac) return;
    setLoading(true);
    setError('');
    try {
      const result = await getDailyHoroscope(zodiac.name, zodiac.kurdishName);
      setHoroscope(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [zodiac]);

  const todayFormatted = new Date().toLocaleDateString('ku', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <StarBackground>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(700)}>
          <Text style={styles.title}>بەختی سنی</Text>
          <Text style={styles.date}>{todayFormatted}</Text>
        </Animated.View>

        {/* User's Sign */}
        {zodiac && (
          <Animated.View entering={FadeInUp.duration(700).delay(200)}>
            <GlassPanel style={styles.signCard}>
              <Text style={styles.signSymbol}>{zodiac.symbol}</Text>
              <Text style={styles.signName}>{zodiac.kurdishName}</Text>
              <Text style={styles.signRange}>{zodiac.dateRange}</Text>
              <Text style={styles.signElement}>
                تەواوکەر: {zodiac.element}
              </Text>
            </GlassPanel>
          </Animated.View>
        )}

        {/* Get Horoscope Button */}
        <Animated.View entering={FadeInUp.duration(700).delay(400)}>
          <CosmicButton
            title="فاڵی ئەمڕۆم پیشان بدە"
            onPress={fetchHoroscope}
            loading={loading}
            variant="secondary"
            style={styles.fetchBtn}
          />
        </Animated.View>

        {/* Loading */}
        {loading && (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={Colors.gold} size="large" />
            <Text style={styles.loadingText}>ئەستێرەکان دەخوێنرێنەوە...</Text>
          </View>
        )}

        {/* Error */}
        {error ? (
          <GlassPanel style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </GlassPanel>
        ) : null}

        {/* Daily Horoscope Result */}
        {horoscope && !loading ? (
          <Animated.View entering={FadeInUp.duration(800)}>
            <GlassPanel style={styles.horoscopeCard}>
              <View style={styles.horoscopeHeader}>
                <Text style={styles.horoscopeIcon}>✨</Text>
                <Text style={styles.horoscopeTitle}>فاڵی ڕۆژانە</Text>
              </View>
              <Text style={styles.horoscopeText}>{horoscope}</Text>
            </GlassPanel>
          </Animated.View>
        ) : null}

        {/* Chinese Zodiac Section */}
        {chinese && (
          <Animated.View entering={FadeInUp.duration(700).delay(600)}>
            <GlassPanel style={styles.chineseCard}>
              <Text style={styles.sectionTitle}>هێمای چینی</Text>
              <Text style={styles.chineseEmoji}>{chinese.emoji}</Text>
              <Text style={styles.chineseName}>{chinese.kurdishName}</Text>
              <Text style={styles.chineseTraits}>{chinese.traits}</Text>
            </GlassPanel>
          </Animated.View>
        )}

        {/* All zodiac signs */}
        <Animated.View entering={FadeInUp.duration(700).delay(800)}>
          <Text style={styles.allSignsTitle}>هەموو بورجەکان</Text>
          <View style={styles.signGrid}>
            {ZODIAC_SIGNS.map((sign) => (
              <GlassPanel
                key={sign.name}
                intensity="light"
                padding={Spacing.md}
                style={[
                  styles.signGridItem,
                  zodiac?.name === sign.name && styles.signGridItemActive,
                ]}
              >
                <Text style={styles.gridSymbol}>{sign.symbol}</Text>
                <Text style={styles.gridName}>{sign.kurdishName}</Text>
              </GlassPanel>
            ))}
          </View>
        </Animated.View>
      </ScrollView>
    </StarBackground>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.xxl,
  },
  title: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.title,
    color: Colors.gold,
    textAlign: 'center',
    writingDirection: 'rtl',
    textShadowColor: Colors.goldDim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 10,
  },
  date: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.xl,
    writingDirection: 'rtl',
  },
  signCard: {
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  signSymbol: {
    fontSize: 64,
    marginBottom: Spacing.sm,
  },
  signName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xxl,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
  },
  signRange: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
  },
  signElement: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.purpleLight,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
  },
  fetchBtn: {
    marginBottom: Spacing.lg,
  },
  loadingBox: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.md,
  },
  loadingText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.gold,
    writingDirection: 'rtl',
  },
  errorCard: {
    marginBottom: Spacing.md,
    borderColor: Colors.error,
  },
  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.error,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  horoscopeCard: {
    marginBottom: Spacing.xl,
  },
  horoscopeHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  horoscopeIcon: {
    fontSize: 24,
  },
  horoscopeTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xl,
    color: Colors.gold,
    writingDirection: 'rtl',
  },
  horoscopeText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
    lineHeight: 30,
  },
  chineseCard: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  sectionTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xl,
    color: Colors.gold,
    marginBottom: Spacing.md,
    writingDirection: 'rtl',
  },
  chineseEmoji: {
    fontSize: 52,
    marginBottom: Spacing.sm,
  },
  chineseName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
  },
  chineseTraits: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.sm,
    writingDirection: 'rtl',
    lineHeight: 26,
  },
  allSignsTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xl,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
    writingDirection: 'rtl',
  },
  signGrid: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    justifyContent: 'center',
  },
  signGridItem: {
    width: '30%',
    alignItems: 'center',
  },
  signGridItemActive: {
    borderColor: Colors.gold,
    borderWidth: 2,
  },
  gridSymbol: {
    fontSize: 28,
    marginBottom: Spacing.xs,
  },
  gridName: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    writingDirection: 'rtl',
  },
});
