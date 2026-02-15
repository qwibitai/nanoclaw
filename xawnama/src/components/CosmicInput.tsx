import React from 'react';
import {
  TextInput,
  View,
  Text,
  StyleSheet,
  TextInputProps,
} from 'react-native';
import {
  Colors,
  BorderRadius,
  FontFamily,
  FontSize,
  Spacing,
} from '../constants/theme';

interface CosmicInputProps extends TextInputProps {
  label?: string;
  error?: string;
}

const CosmicInput: React.FC<CosmicInputProps> = ({
  label,
  error,
  style,
  ...props
}) => {
  return (
    <View style={styles.container}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        style={[styles.input, error && styles.inputError, style]}
        placeholderTextColor={Colors.textMuted}
        selectionColor={Colors.purpleLight}
        writingDirection="rtl"
        textAlign="right"
        {...props}
      />
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: Spacing.md,
  },
  label: {
    fontFamily: FontFamily.semiBold,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    fontFamily: FontFamily.regular,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
  inputError: {
    borderColor: Colors.error,
  },
  error: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.error,
    marginTop: Spacing.xs,
    writingDirection: 'rtl',
    textAlign: 'right',
  },
});

export default CosmicInput;
