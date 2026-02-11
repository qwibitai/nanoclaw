import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import StarBackground from '../components/StarBackground';
import FloatingMoon from '../components/FloatingMoon';
import GlassPanel from '../components/GlassPanel';
import { useAuth } from '../context/AuthContext';
import { useAudio } from '../context/AudioContext';
import { MainTabParamList } from '../types';
import { getZodiacSign, getChineseZodiac } from '../constants/zodiac';
import {
  Colors,
  FontFamily,
  FontSize,
  Spacing,
  BorderRadius,
} from '../constants/theme';

type Nav = BottomTabNavigationProp<MainTabParamList>;

export default function HomeScreen() {
  const { user, signOut } = useAuth();
  const { isMuted, toggleMute } = useAudio();
  const navigation = useNavigation<Nav>();

  const zodiac = user
    ? getZodiacSign(user.dateOfBirth.month, user.dateOfBirth.day)
    : null;
  const chinese = user ? getChineseZodiac(user.dateOfBirth.year) : null;

  return (
    <StarBackground>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Audio toggle */}
        <TouchableOpacity style={styles.muteBtn} onPress={toggleMute}>
          <Text style={styles.muteIcon}>{isMuted ? '🔇' : '🔊'}</Text>
        </TouchableOpacity>

        {/* Moon */}
        <Animated.View entering={FadeInDown.duration(1000)} style={styles.moonSection}>
          <FloatingMoon size={130} />
        </Animated.View>

        {/* Greeting */}
        <Animated.View entering={FadeInUp.duration(800).delay(300)}>
          <Text style={styles.greeting}>
            بەخێربێیت، {user?.fullName || 'ڕێبوار'}
          </Text>
          <Text style={styles.greetingSub}>ئاسمان ئەمشەو ڕووناکە بۆ تۆ</Text>
        </Animated.View>

        {/* Zodiac Card */}
        {zodiac && (
          <Animated.View entering={FadeInUp.duration(800).delay(500)}>
            <GlassPanel style={styles.zodiacCard}>
              <View style={styles.zodiacHeader}>
                <Text style={styles.zodiacSymbol}>{zodiac.symbol}</Text>
                <View style={styles.zodiacInfo}>
                  <Text style={styles.zodiacName}>{zodiac.kurdishName}</Text>
                  <Text style={styles.zodiacRange}>{zodiac.dateRange}</Text>
                  <Text style={styles.zodiacElement}>
                    تەواوکەر: {zodiac.element}
                  </Text>
                </View>
              </View>
            </GlassPanel>
          </Animated.View>
        )}

        {/* Chinese Zodiac */}
        {chinese && (
          <Animated.View entering={FadeInUp.duration(800).delay(700)}>
            <GlassPanel style={styles.chineseCard}>
              <Text style={styles.chineseEmoji}>{chinese.emoji}</Text>
              <Text style={styles.chineseName}>
                هێمای چینی: {chinese.kurdishName}
              </Text>
              <Text style={styles.chineseTraits}>{chinese.traits}</Text>
            </GlassPanel>
          </Animated.View>
        )}

        {/* Feature Cards */}
        <Animated.View entering={FadeInUp.duration(800).delay(900)} style={styles.features}>
          <TouchableOpacity
            style={styles.featureCard}
            onPress={() => navigation.navigate('Dream')}
            activeOpacity={0.8}
          >
            <GlassPanel intensity="light" style={styles.featureInner}>
              <Text style={styles.featureIcon}>🌙</Text>
              <Text style={styles.featureTitle}>خەون لێکدانەوە</Text>
              <Text style={styles.featureDesc}>
                خەونەکانت بنووسە بۆمان
              </Text>
            </GlassPanel>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.featureCard}
            onPress={() => navigation.navigate('Horoscope')}
            activeOpacity={0.8}
          >
            <GlassPanel intensity="light" style={styles.featureInner}>
              <Text style={styles.featureIcon}>✨</Text>
              <Text style={styles.featureTitle}>فاڵی ڕۆژانە</Text>
              <Text style={styles.featureDesc}>
                فاڵەکەت ببینەوە
              </Text>
            </GlassPanel>
          </TouchableOpacity>
        </Animated.View>

        {/* Sign out */}
        <TouchableOpacity style={styles.signOutBtn} onPress={signOut}>
          <Text style={styles.signOutText}>چوونەدەرەوە</Text>
        </TouchableOpacity>
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
  muteBtn: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 10,
    padding: Spacing.sm,
  },
  muteIcon: {
    fontSize: 24,
  },
  moonSection: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
    height: 180,
    justifyContent: 'center',
  },
  greeting: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xxl,
    color: Colors.gold,
    textAlign: 'center',
    writingDirection: 'rtl',
    textShadowColor: Colors.goldDim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 10,
  },
  greetingSub: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.xs,
    marginBottom: Spacing.xl,
    writingDirection: 'rtl',
  },
  zodiacCard: {
    marginBottom: Spacing.md,
  },
  zodiacHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.md,
  },
  zodiacSymbol: {
    fontSize: 52,
  },
  zodiacInfo: {
    flex: 1,
    alignItems: 'flex-end',
  },
  zodiacName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.xl,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
  },
  zodiacRange: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    writingDirection: 'rtl',
  },
  zodiacElement: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.purpleLight,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
  },
  chineseCard: {
    marginBottom: Spacing.lg,
    alignItems: 'center',
  },
  chineseEmoji: {
    fontSize: 44,
    marginBottom: Spacing.sm,
  },
  chineseName: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.gold,
    writingDirection: 'rtl',
    textAlign: 'center',
  },
  chineseTraits: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
    writingDirection: 'rtl',
    textAlign: 'center',
    lineHeight: 26,
  },
  features: {
    flexDirection: 'row-reverse',
    gap: Spacing.md,
    marginBottom: Spacing.xl,
  },
  featureCard: {
    flex: 1,
  },
  featureInner: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
  },
  featureIcon: {
    fontSize: 36,
    marginBottom: Spacing.sm,
  },
  featureTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
    textAlign: 'center',
  },
  featureDesc: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
    textAlign: 'center',
  },
  signOutBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  signOutText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    writingDirection: 'rtl',
  },
});
