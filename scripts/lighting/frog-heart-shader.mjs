const { AdaptiveColorationShader } = foundry.canvas.rendering.shaders;

/**
 * A deliberately simple frog-and-heart emblem rendered inside a light source.
 * The effect is procedural, so it needs no texture and follows token lights.
 */
export class FrogHeartColorationShader extends AdaptiveColorationShader {
  static forceDefaultColor = true;

  static _createFragmentShader() {
    return `
    ${this.SHADER_HEADER}
    ${this.PERCEIVED_BRIGHTNESS}

    float ellipseMask(vec2 point, vec2 center, vec2 radius, float softness) {
      float distanceFromEdge = length((point - center) / radius) - 1.0;
      return 1.0 - smoothstep(-softness, softness, distanceFromEdge);
    }

    float heartDistance(vec2 point) {
      // Signed distance to a heart with two round lobes and a clean point.
      vec2 p = vec2(abs(point.x), point.y);
      if (p.x + p.y > 1.0) {
        return length(p - vec2(0.25, 0.75)) - 0.3535534;
      }
      vec2 lowerPoint = p - 0.5 * max(p.x + p.y, 0.0);
      float distanceToCleft = dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0));
      float distanceToPoint = dot(lowerPoint, lowerPoint);
      return sqrt(min(distanceToCleft, distanceToPoint)) * sign(p.x - p.y);
    }

    void main() {
      ${this.FRAGMENT_BEGIN}

      vec2 point = (vUvs - vec2(0.5)) * 2.0;
      float pulseAmount = 0.94 + 0.06 * sin(time * 2.2);
      point /= pulseAmount;

      // Tilt all facial features together around the center of the head.
      vec2 headPivot = vec2(0.0, -0.55);
      float headAngle = 0.085;
      float headCos = cos(headAngle);
      float headSin = sin(headAngle);
      vec2 headOffset = point - headPivot;
      vec2 headPoint = mat2(headCos, -headSin, headSin, headCos) * headOffset + headPivot;

      vec2 heartPoint = vec2(point.x / 1.27, 0.50 - (point.y - 0.30) / 1.08);
      float heartSdf = heartDistance(heartPoint);
      float heart = 1.0 - smoothstep(-0.018, 0.018, heartSdf);
      float heartInterior = 1.0 - smoothstep(-0.100, -0.075, heartSdf);

      // A compact head sits behind the larger heart.
      float face = ellipseMask(headPoint, vec2(0.0, -0.53), vec2(0.55, 0.22), 0.045);
      float leftEyeBump = ellipseMask(headPoint, vec2(-0.29, -0.72), vec2(0.18, 0.17), 0.055);
      float rightEyeBump = ellipseMask(headPoint, vec2(0.29, -0.72), vec2(0.18, 0.17), 0.055);
      float frog = max(face, max(leftEyeBump, rightEyeBump));

      float leftEye = ellipseMask(headPoint, vec2(-0.29, -0.72), vec2(0.078, 0.090), 0.08);
      float rightEye = ellipseMask(headPoint, vec2(0.29, -0.72), vec2(0.078, 0.090), 0.08);
      float eyes = max(leftEye, rightEye);
      float leftPupil = ellipseMask(headPoint, vec2(-0.29, -0.71), vec2(0.030, 0.043), 0.10);
      float rightPupil = ellipseMask(headPoint, vec2(0.29, -0.71), vec2(0.030, 0.043), 0.10);
      float pupils = max(leftPupil, rightPupil);

      float leftNostril = ellipseMask(headPoint, vec2(-0.070, -0.575), vec2(0.023, 0.032), 0.10);
      float rightNostril = ellipseMask(headPoint, vec2(0.070, -0.575), vec2(0.023, 0.032), 0.10);
      float nostrils = max(leftNostril, rightNostril);

      // A small curved-looking mouth made from two overlapping ellipses.
      float mouthOuter = ellipseMask(headPoint, vec2(0.0, -0.48), vec2(0.39, 0.120), 0.05);
      float mouthCutout = ellipseMask(headPoint, vec2(0.0, -0.54), vec2(0.36, 0.092), 0.05);
      float smile = mouthOuter * (1.0 - mouthCutout);
      float tongue = ellipseMask(headPoint, vec2(0.0, -0.415), vec2(0.125, 0.046), 0.07) * smile;

      // A compact ellipse behind the heart closes the gap and hints at folded arms.
      float arms = ellipseMask(point, vec2(0.0, -0.20), vec2(0.65, 0.29), 0.040);

      // Simple hands resting on the upper sides of the heart.
      float leftHand = ellipseMask(point, vec2(-0.66, -0.20), vec2(0.12, 0.145), 0.055);
      float rightHand = ellipseMask(point, vec2(0.66, -0.20), vec2(0.12, 0.145), 0.055);
      float hands = max(leftHand, rightHand);

      vec3 red = vec3(0.78, 0.055, 0.040);
      vec3 yellow = vec3(0.82, 0.56, 0.055);
      vec3 green = vec3(0.16, 0.76, 0.10);
      vec3 tongueRed = vec3(0.88, 0.12, 0.16);
      vec3 warmWhite = vec3(0.90, 0.86, 0.68);
      vec3 auraWhite = vec3(0.78, 0.77, 0.70);
      vec3 darkGreen = vec3(0.005, 0.055, 0.01);

      // Paint from back to front: frog, heart, then the hands gripping it.
      vec3 emblem = green * max(frog, arms);
      emblem = mix(emblem, warmWhite, eyes);
      emblem = mix(emblem, darkGreen, pupils);
      emblem = mix(emblem, darkGreen, nostrils);
      emblem = mix(emblem, darkGreen, smile);
      emblem = mix(emblem, tongueRed, tongue);
      emblem = mix(emblem, red, heart);
      emblem = mix(emblem, yellow, heartInterior);
      emblem = mix(emblem, green, hands);

      float symbol = max(max(max(heart, frog), arms), hands);
      float aura = (1.0 - smoothstep(0.96, 1.0, dist)) * (0.58 + 0.04 * sin(time * 1.7));
      float halo = (1.0 - smoothstep(0.48, 1.0, dist)) * 0.11;
      float upperHalf = 1.0 - smoothstep(-0.55, -0.15, point.y);
      vec3 haloColor = mix(red, green, upperHalf);
      vec3 auraColor = auraWhite * aura + haloColor * halo;
      finalColor = mix(auraColor, emblem, symbol) * colorationAlpha;

      ${this.ADJUSTMENTS}
      ${this.FRAGMENT_END}
    }`;
  }
}

export function registerFrogHeartLightAnimation() {
  CONFIG.Canvas.lightAnimations.frogHeart = {
    label: "Frosch mit Herz",
    animation: foundry.canvas.sources.PointLightSource.prototype.animateTime,
    colorationShader: FrogHeartColorationShader
  };
}
