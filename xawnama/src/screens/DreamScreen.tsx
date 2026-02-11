import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import StarBackground from '../components/StarBackground';
import GlassPanel from '../components/GlassPanel';
import CosmicButton from '../components/CosmicButton';
import { interpretDream } from '../services/geminiService';
import {
  Colors,
  FontFamily,
  FontSize,
  Spacing,
  BorderRadius,
} from '../constants/theme';

interface InterpretationResult {
  meaning: string;
  warning: string;
  goodNews: string;
}

export default function DreamScreen() {
  const [dreamText, setDreamText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InterpretationResult | null>(null);
  const [error, setError] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const handleInterpret = async () => {
    if (!dreamText.trim()) return;
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const interpretation = await interpretDream(dreamText.trim());
      setResult(interpretation);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setDreamText('');
    setResult(null);
    setError('');
  };

  return (
    <StarBackground>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={100}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <Animated.View entering={FadeInDown.duration(700)}>
            <Text style={styles.title}>خەون لێکدانەوە</Text>
            <Text style={styles.subtitle}>
              خەونەکەت بنووسە، ئێمە واتاکەی بۆ دەدۆزینەوە
            </Text>
          </Animated.View>

          {/* Dream Input */}
          <Animated.View entering={FadeInUp.duration(700).delay(200)}>
            <GlassPanel style={styles.inputCard}>
              <TextInput
                style={styles.dreamInput}
                placeholder="خەونەکەت لێرە بنووسە..."
                placeholderTextColor={Colors.textMuted}
                value={dreamText}
                onChangeText={setDreamText}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
                writingDirection="rtl"
                textAlign="right"
                selectionColor={Colors.purpleLight}
                editable={!loading}
              />

              {/* Voice placeholder */}
              <View style={styles.voicePlaceholder}>
                <Text style={styles.voiceIcon}>🎙️</Text>
                <Text style={styles.voiceText}>
                  تۆمارکردنی دەنگ (بەم زووانە)
                </Text>
              </View>
            </GlassPanel>
          </Animated.View>

          {/* Action buttons */}
          <Animated.View entering={FadeInUp.duration(700).delay(400)} style={styles.actions}>
            <CosmicButton
              title="خەونەکەم لێکبدەرەوە"
              onPress={handleInterpret}
              loading={loading}
              disabled={!dreamText.trim()}
            />
            {result && (
              <CosmicButton
                title="خەونی نوێ"
                onPress={handleReset}
                variant="ghost"
                style={styles.resetBtn}
              />
            )}
          </Animated.View>

          {/* Loading state */}
          {loading && (
            <Animated.View entering={FadeInUp.duration(500)} style={styles.loadingBox}>
              <ActivityIndicator color={Colors.purpleLight} size="large" />
              <Text style={styles.loadingText}>
                ئەستێرەکان خەونەکەت لێکدەدەنەوە...
              </Text>
            </Animated.View>
          )}

          {/* Error */}
          {error ? (
            <Animated.View entering={FadeInUp.duration(500)}>
              <GlassPanel style={styles.errorCard}>
                <Text style={styles.errorText}>{error}</Text>
              </GlassPanel>
            </Animated.View>
          ) : null}

          {/* Result */}
          {result && (
            <Animated.View entering={FadeInUp.duration(800)}>
              {/* Meaning */}
              <GlassPanel style={styles.resultCard}>
                <View style={styles.resultHeader}>
                  <Text style={styles.resultIcon}>🔮</Text>
                  <Text style={styles.resultTitle}>واتا</Text>
                </View>
                <Text style={styles.resultText}>{result.meaning}</Text>
              </GlassPanel>

              {/* Warning */}
              <GlassPanel style={[styles.resultCard, styles.warningCard]}>
                <View style={styles.resultHeader}>
                  <Text style={styles.resultIcon}>⚠️</Text>
                  <Text style={styles.resultTitle}>ئاگاداری</Text>
                </View>
                <Text style={styles.resultText}>{result.warning}</Text>
              </GlassPanel>

              {/* Good News */}
              <GlassPanel style={[styles.resultCard, styles.goodCard]}>
                <View style={styles.resultHeader}>
                  <Text style={styles.resultIcon}>🌟</Text>
                  <Text style={styles.resultTitle}>مژدە</Text>
                </View>
                <Text style={styles.resultText}>{result.goodNews}</Text>
              </GlassPanel>
            </Animated.View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </StarBackground>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.xl,
    writingDirection: 'rtl',
  },
  inputCard: {
    marginBottom: Spacing.lg,
  },
  dreamInput: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    minHeight: 150,
    writingDirection: 'rtl',
    textAlign: 'right',
    lineHeight: 28,
  },
  voicePlaceholder: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.glassBorder,
    opacity: 0.5,
  },
  voiceIcon: {
    fontSize: 20,
  },
  voiceText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    writingDirection: 'rtl',
  },
  actions: {
    marginBottom: Spacing.lg,
  },
  resetBtn: {
    marginTop: Spacing.sm,
  },
  loadingBox: {
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    gap: Spacing.md,
  },
  loadingText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.purpleLight,
    writingDirection: 'rtl',
    textAlign: 'center',
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
    lineHeight: 26,
  },
  resultCard: {
    marginBottom: Spacing.md,
  },
  warningCard: {
    borderColor: 'rgba(255, 230, 109, 0.3)',
  },
  goodCard: {
    borderColor: 'rgba(78, 205, 196, 0.3)',
  },
  resultHeader: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  resultIcon: {
    fontSize: 24,
  },
  resultTitle: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.gold,
    writingDirection: 'rtl',
  },
  resultText: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    writingDirection: 'rtl',
    textAlign: 'right',
    lineHeight: 28,
  },
});
