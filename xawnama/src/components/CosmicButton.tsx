import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Colors,
  Gradients,
  BorderRadius,
  FontFamily,
  FontSize,
  Spacing,
} from '../constants/theme';

interface CosmicButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
  style?: StyleProp<ViewStyle>;
}

const CosmicButton: React.FC<CosmicButtonProps> = ({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  style,
}) => {
  if (variant === 'ghost') {
    return (
      <TouchableOpacity
        style={[styles.ghost, style]}
        onPress={onPress}
        disabled={disabled || loading}
        activeOpacity={0.7}
      >
        <Text style={styles.ghostText}>{title}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      style={style}
    >
      <LinearGradient
        colors={
          variant === 'secondary'
            ? ([...Gradients.goldShimmer] as [string, string, string])
            : ([...Gradients.purpleGlow] as [string, string, string])
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.gradient, (disabled || loading) && styles.disabled]}
      >
        {loading ? (
          <ActivityIndicator color={Colors.textPrimary} />
        ) : (
          <Text
            style={[
              styles.text,
              variant === 'secondary' && styles.secondaryText,
            ]}
          >
            {title}
          </Text>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  gradient: {
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.purple,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  disabled: {
    opacity: 0.5,
  },
  text: {
    fontFamily: FontFamily.bold,
    fontSize: FontSize.lg,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
  },
  secondaryText: {
    color: Colors.backgroundDark,
  },
  ghost: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
  },
  ghostText: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.purpleLight,
    writingDirection: 'rtl',
  },
});

export default CosmicButton;
