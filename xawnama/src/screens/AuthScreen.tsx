import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  I18nManager,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
} from 'react-native-reanimated';
import StarBackground from '../components/StarBackground';
import GlassPanel from '../components/GlassPanel';
import CosmicButton from '../components/CosmicButton';
import CosmicInput from '../components/CosmicInput';
import { useAuth } from '../context/AuthContext';
import {
  Colors,
  FontFamily,
  FontSize,
  Spacing,
  BorderRadius,
} from '../constants/theme';
import { UserProfile } from '../types';

type AuthMode = 'login' | 'signup';
type Gender = UserProfile['gender'];
type MaritalStatus = UserProfile['maritalStatus'];

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'male', label: 'نێر' },
  { value: 'female', label: 'مێ' },
  { value: 'other', label: 'تر' },
];

const MARITAL_OPTIONS: { value: MaritalStatus; label: string }[] = [
  { value: 'single', label: 'سەربەخۆ' },
  { value: 'married', label: 'خێزاندار' },
  { value: 'divorced', label: 'جیابووەوە' },
  { value: 'widowed', label: 'بێوەژن/مرد' },
];

export default function AuthScreen() {
  const { signUp, signIn, loading } = useAuth();
  const [mode, setMode] = useState<AuthMode>('signup');
  const [error, setError] = useState('');

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Signup fields
  const [fullName, setFullName] = useState('');
  const [dobDay, setDobDay] = useState('');
  const [dobMonth, setDobMonth] = useState('');
  const [dobYear, setDobYear] = useState('');
  const [timeOfBirth, setTimeOfBirth] = useState('');
  const [gender, setGender] = useState<Gender>('male');
  const [maritalStatus, setMaritalStatus] = useState<MaritalStatus>('single');

  const handleLogin = async () => {
    setError('');
    if (!email || !password) {
      setError('تکایە هەموو خانەکان پڕبکەوە');
      return;
    }
    try {
      await signIn(email.trim(), password);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSignup = async () => {
    setError('');
    if (!email || !password || !fullName || !dobDay || !dobMonth || !dobYear) {
      setError('تکایە هەموو خانە پێویستەکان پڕبکەوە');
      return;
    }

    const day = parseInt(dobDay, 10);
    const month = parseInt(dobMonth, 10);
    const year = parseInt(dobYear, 10);

    if (isNaN(day) || isNaN(month) || isNaN(year) || day < 1 || day > 31 || month < 1 || month > 12) {
      setError('بەرواری لەدایکبوون دروست نییە');
      return;
    }

    try {
      await signUp(email.trim(), password, {
        fullName,
        dateOfBirth: { day, month, year },
        timeOfBirth: timeOfBirth || undefined,
        gender,
        maritalStatus,
      });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const renderChipGroup = <T extends string>(
    options: { value: T; label: string }[],
    selected: T,
    onSelect: (v: T) => void
  ) => (
    <View style={styles.chipRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.chip, selected === opt.value && styles.chipSelected]}
          onPress={() => onSelect(opt.value)}
        >
          <Text
            style={[
              styles.chipText,
              selected === opt.value && styles.chipTextSelected,
            ]}
          >
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <StarBackground>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Title */}
          <Animated.View entering={FadeInDown.duration(800)} style={styles.titleBlock}>
            <Text style={styles.titleArabic}>خەوننامە</Text>
            <Text style={styles.subtitle}>دەروازەی ئاسمان</Text>
          </Animated.View>

          {/* Auth Card */}
          <Animated.View entering={FadeInUp.duration(800).delay(300)}>
            <GlassPanel style={styles.card}>
              {/* Mode toggle */}
              <View style={styles.modeToggle}>
                <TouchableOpacity
                  style={[styles.modeBtn, mode === 'login' && styles.modeBtnActive]}
                  onPress={() => { setMode('login'); setError(''); }}
                >
                  <Text style={[styles.modeText, mode === 'login' && styles.modeTextActive]}>
                    چوونەژوورەوە
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modeBtn, mode === 'signup' && styles.modeBtnActive]}
                  onPress={() => { setMode('signup'); setError(''); }}
                >
                  <Text style={[styles.modeText, mode === 'signup' && styles.modeTextActive]}>
                    تۆمارکردن
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Common fields */}
              <CosmicInput
                label="ئیمەیڵ"
                placeholder="name@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                textAlign="left"
                writingDirection="ltr"
              />
              <CosmicInput
                label="وشەی نهێنی"
                placeholder="••••••••"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textAlign="left"
                writingDirection="ltr"
              />

              {/* Signup-only fields */}
              {mode === 'signup' && (
                <Animated.View entering={FadeInDown.duration(500)}>
                  <CosmicInput
                    label="ناوی تەواو"
                    placeholder="ناوت بنووسە"
                    value={fullName}
                    onChangeText={setFullName}
                  />

                  {/* Date of Birth */}
                  <Text style={styles.sectionLabel}>بەرواری لەدایکبوون</Text>
                  <View style={styles.dobRow}>
                    <CosmicInput
                      placeholder="ساڵ"
                      value={dobYear}
                      onChangeText={setDobYear}
                      keyboardType="number-pad"
                      style={styles.dobInput}
                    />
                    <CosmicInput
                      placeholder="مانگ"
                      value={dobMonth}
                      onChangeText={setDobMonth}
                      keyboardType="number-pad"
                      style={styles.dobInput}
                    />
                    <CosmicInput
                      placeholder="ڕۆژ"
                      value={dobDay}
                      onChangeText={setDobDay}
                      keyboardType="number-pad"
                      style={styles.dobInput}
                    />
                  </View>

                  {/* Time of birth (optional) */}
                  <CosmicInput
                    label="کاتی لەدایکبوون (ئیختیاری)"
                    placeholder="14:30"
                    value={timeOfBirth}
                    onChangeText={setTimeOfBirth}
                    keyboardType="numbers-and-punctuation"
                    textAlign="left"
                    writingDirection="ltr"
                  />

                  {/* Gender */}
                  <Text style={styles.sectionLabel}>ڕەگەز</Text>
                  {renderChipGroup(GENDER_OPTIONS, gender, setGender)}

                  {/* Marital Status */}
                  <Text style={styles.sectionLabel}>بارودۆخی خێزانی</Text>
                  {renderChipGroup(MARITAL_OPTIONS, maritalStatus, setMaritalStatus)}
                </Animated.View>
              )}

              {/* Error */}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              {/* Submit */}
              <CosmicButton
                title={mode === 'login' ? 'چوونەژوورەوە' : 'تۆمارکردن'}
                onPress={mode === 'login' ? handleLogin : handleSignup}
                loading={loading}
                style={styles.submitBtn}
              />
            </GlassPanel>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </StarBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xxl,
  },
  titleBlock: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  titleArabic: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.hero,
    color: Colors.gold,
    textShadowColor: Colors.goldDim,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 20,
    writingDirection: 'rtl',
  },
  subtitle: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.lg,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
  },
  card: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xl,
  },
  modeToggle: {
    flexDirection: 'row-reverse',
    marginBottom: Spacing.xl,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: BorderRadius.xl,
    padding: 4,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center',
    borderRadius: BorderRadius.lg,
  },
  modeBtnActive: {
    backgroundColor: Colors.purple,
  },
  modeText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.textMuted,
    writingDirection: 'rtl',
  },
  modeTextActive: {
    color: Colors.textPrimary,
  },
  sectionLabel: {
    fontFamily: FontFamily.semiBold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
    marginTop: Spacing.sm,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  dobRow: {
    flexDirection: 'row-reverse',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  dobInput: {
    flex: 1,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  chipRow: {
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  chipSelected: {
    backgroundColor: Colors.purple,
    borderColor: Colors.purpleLight,
  },
  chipText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    writingDirection: 'rtl',
  },
  chipTextSelected: {
    color: Colors.textPrimary,
  },
  errorText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.error,
    textAlign: 'center',
    marginTop: Spacing.sm,
    writingDirection: 'rtl',
  },
  submitBtn: {
    marginTop: Spacing.lg,
  },
});
