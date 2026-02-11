import React from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { Colors, BorderRadius, Spacing } from '../constants/theme';

interface GlassPanelProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: 'light' | 'medium' | 'strong';
  padding?: number;
}

const GlassPanel: React.FC<GlassPanelProps> = ({
  children,
  style,
  intensity = 'medium',
  padding = Spacing.lg,
}) => {
  const bgOpacity =
    intensity === 'light' ? 0.06 : intensity === 'strong' ? 0.18 : 0.1;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: `rgba(255, 255, 255, ${bgOpacity})`,
          padding,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    overflow: 'hidden',
  },
});

export default GlassPanel;
