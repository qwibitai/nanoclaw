import React, { useEffect, useMemo } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, Gradients } from '../constants/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const NUM_STARS = 80;
const NUM_SHOOTING_STARS = 3;

interface Star {
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

function generateStars(count: number): Star[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * SCREEN_WIDTH,
    y: Math.random() * SCREEN_HEIGHT,
    size: Math.random() * 3 + 1,
    delay: Math.random() * 3000,
    duration: Math.random() * 2000 + 1500,
  }));
}

const TwinklingStar: React.FC<{ star: Star }> = React.memo(({ star }) => {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      star.delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: star.duration, easing: Easing.inOut(Easing.sine) }),
          withTiming(0.2, { duration: star.duration, easing: Easing.inOut(Easing.sine) })
        ),
        -1,
        true
      )
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.star,
        animatedStyle,
        {
          left: star.x,
          top: star.y,
          width: star.size,
          height: star.size,
          borderRadius: star.size / 2,
          backgroundColor: star.size > 2.5 ? Colors.goldLight : Colors.starWhite,
          shadowColor: star.size > 2.5 ? Colors.gold : Colors.starWhite,
          shadowRadius: star.size * 2,
          shadowOpacity: 0.8,
          elevation: 2,
        },
      ]}
    />
  );
});

const ShootingStar: React.FC<{ index: number }> = React.memo(({ index }) => {
  const translateX = useSharedValue(-100);
  const translateY = useSharedValue(-50);
  const opacity = useSharedValue(0);

  const startY = useMemo(() => Math.random() * (SCREEN_HEIGHT * 0.5), []);
  const angle = useMemo(() => Math.random() * 20 + 15, []);

  useEffect(() => {
    const triggerAnimation = () => {
      const delay = (Math.random() * 8000 + 4000) * (index + 1);
      translateX.value = -100;
      translateY.value = startY;
      opacity.value = 0;

      translateX.value = withDelay(
        delay,
        withTiming(SCREEN_WIDTH + 200, {
          duration: 1200,
          easing: Easing.out(Easing.quad),
        })
      );
      translateY.value = withDelay(
        delay,
        withTiming(startY + SCREEN_WIDTH * Math.tan((angle * Math.PI) / 180), {
          duration: 1200,
          easing: Easing.out(Easing.quad),
        })
      );
      opacity.value = withDelay(
        delay,
        withSequence(
          withTiming(1, { duration: 200 }),
          withTiming(1, { duration: 600 }),
          withTiming(0, { duration: 400 }),
          withTiming(0, { duration: 100 }, () => {
            runOnJS(triggerAnimation)();
          })
        )
      );
    };

    triggerAnimation();
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${angle}deg` },
    ],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[styles.shootingStar, animatedStyle]}>
      <LinearGradient
        colors={['transparent', Colors.starWhite]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.shootingStarTrail}
      />
      <View style={styles.shootingStarHead} />
    </Animated.View>
  );
});

const StarBackground: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const stars = useMemo(() => generateStars(NUM_STARS), []);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[...Gradients.cosmicNight]}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />

      {stars.map((star, i) => (
        <TwinklingStar key={`star-${i}`} star={star} />
      ))}

      {Array.from({ length: NUM_SHOOTING_STARS }, (_, i) => (
        <ShootingStar key={`shooting-${i}`} index={i} />
      ))}

      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  star: {
    position: 'absolute',
  },
  shootingStar: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
  },
  shootingStarTrail: {
    width: 80,
    height: 2,
    borderRadius: 1,
  },
  shootingStarHead: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.starWhite,
    shadowColor: Colors.starWhite,
    shadowRadius: 6,
    shadowOpacity: 1,
    elevation: 4,
  },
});

export default StarBackground;
