import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Colors } from '../constants/theme';

interface FloatingMoonProps {
  size?: number;
}

const FloatingMoon: React.FC<FloatingMoonProps> = ({ size = 120 }) => {
  const translateY = useSharedValue(0);
  const rotate = useSharedValue(0);
  const glowOpacity = useSharedValue(0.4);

  useEffect(() => {
    translateY.value = withRepeat(
      withSequence(
        withTiming(-15, { duration: 3000, easing: Easing.inOut(Easing.sine) }),
        withTiming(15, { duration: 3000, easing: Easing.inOut(Easing.sine) })
      ),
      -1,
      true
    );

    rotate.value = withRepeat(
      withSequence(
        withTiming(5, { duration: 6000, easing: Easing.inOut(Easing.sine) }),
        withTiming(-5, { duration: 6000, easing: Easing.inOut(Easing.sine) })
      ),
      -1,
      true
    );

    glowOpacity.value = withRepeat(
      withSequence(
        withTiming(0.7, { duration: 2000, easing: Easing.inOut(Easing.sine) }),
        withTiming(0.3, { duration: 2000, easing: Easing.inOut(Easing.sine) })
      ),
      -1,
      true
    );
  }, []);

  const moonStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
    ],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const craterSize = size * 0.15;
  const craterSmall = size * 0.08;

  return (
    <View style={styles.wrapper}>
      {/* Outer glow */}
      <Animated.View
        style={[
          styles.outerGlow,
          glowStyle,
          {
            width: size * 1.8,
            height: size * 1.8,
            borderRadius: size * 0.9,
          },
        ]}
      />

      <Animated.View style={[styles.moonContainer, moonStyle]}>
        {/* Moon body */}
        <View
          style={[
            styles.moon,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
            },
          ]}
        >
          {/* Craters for 3D effect */}
          <View
            style={[
              styles.crater,
              {
                width: craterSize,
                height: craterSize,
                borderRadius: craterSize / 2,
                top: size * 0.2,
                left: size * 0.3,
              },
            ]}
          />
          <View
            style={[
              styles.crater,
              {
                width: craterSmall,
                height: craterSmall,
                borderRadius: craterSmall / 2,
                top: size * 0.5,
                left: size * 0.6,
              },
            ]}
          />
          <View
            style={[
              styles.crater,
              {
                width: craterSize * 0.8,
                height: craterSize * 0.8,
                borderRadius: (craterSize * 0.8) / 2,
                top: size * 0.65,
                left: size * 0.25,
              },
            ]}
          />
          <View
            style={[
              styles.crater,
              {
                width: craterSmall * 0.9,
                height: craterSmall * 0.9,
                borderRadius: (craterSmall * 0.9) / 2,
                top: size * 0.35,
                left: size * 0.55,
              },
            ]}
          />

          {/* Shadow for 3D effect */}
          <View
            style={[
              styles.moonShadow,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
              },
            ]}
          />
        </View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  outerGlow: {
    position: 'absolute',
    backgroundColor: Colors.moonGlow,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 60,
    elevation: 20,
  },
  moonContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  moon: {
    backgroundColor: '#F5E6B8',
    shadowColor: Colors.moonGlow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 30,
    elevation: 15,
    overflow: 'hidden',
  },
  crater: {
    position: 'absolute',
    backgroundColor: 'rgba(200, 180, 140, 0.6)',
    shadowColor: 'rgba(0,0,0,0.2)',
    shadowOffset: { width: 1, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  moonShadow: {
    position: 'absolute',
    top: 0,
    left: 0,
    // Gradient-like shadow using a dark overlay on the right
    backgroundColor: 'transparent',
    borderRightWidth: 25,
    borderRightColor: 'rgba(80, 60, 20, 0.15)',
    borderTopWidth: 10,
    borderTopColor: 'transparent',
    borderBottomWidth: 10,
    borderBottomColor: 'transparent',
  },
});

export default FloatingMoon;
