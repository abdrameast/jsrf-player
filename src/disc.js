import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SavePass } from 'three/addons/postprocessing/SavePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const RADIUS = 1.2;
const SEGMENTS = 320;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, rate, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-rate * dt));

// The complete disc is in millimetres / 50: 120 mm across, 1.2 mm thick.
function annulus(inner, outer, segments = SEGMENTS) {
  const geometry = new THREE.RingGeometry(inner, outer, segments, 2);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) / 2.4 + 0.5, position.getY(i) / 2.4 + 0.5);
  }
  geometry.computeTangents();
  return geometry;
}

function makeSurfaceTextures() {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2, dy = y - size / 2;
      const length = Math.max(1, Math.hypot(dx, dy));
      const i = (y * size + x) * 4;
      // RG encode the tangent to concentric grooves in the planar UV basis.
      data[i] = Math.round((-dy / length * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((dx / length * 0.5 + 0.5) * 255);
      data[i + 2] = 230;
      data[i + 3] = 255;
    }
  }
  const anisotropy = new THREE.DataTexture(data, size, size);
  anisotropy.needsUpdate = true;
  anisotropy.magFilter = THREE.LinearFilter;
  anisotropy.minFilter = THREE.LinearFilter;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#bdbdbd';
  ctx.fillRect(0, 0, 1024, 1024);
  // Seeded scratches: no flicker, and only this subtle imperfection rotates.
  let seed = 6178;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 850; i++) {
    const radius = 195 + random() * 302;
    const angle = random() * TAU;
    ctx.strokeStyle = `rgba(255,255,255,${0.04 + random() * 0.1})`;
    ctx.lineWidth = 0.3 + random() * 0.5;
    ctx.beginPath();
    ctx.arc(512, 512, radius, angle, angle + 0.02 + random() * 0.15);
    ctx.stroke();
  }
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(random() * 1024, random() * 1024, 0.7, 0.7);
  }
  const roughness = new THREE.CanvasTexture(canvas);
  return { anisotropy, roughness };
}

function makeMatrixTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.translate(512, 512);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '7px monospace';
  ctx.fillStyle = 'rgba(18,24,30,.72)';
  const text = 'GRIND // FM  •  PIRATE AUDIO  •  120MM OPTICAL SOUND  •  SIDE A  •  ';
  for (let i = 0; i < text.length; i++) {
    ctx.save();
    ctx.rotate(i / text.length * TAU);
    ctx.fillText(text[i], 0, -169);
    ctx.restore();
  }
  for (let i = 0; i < 100; i++) {
    ctx.save();
    ctx.rotate(i / 100 * TAU);
    ctx.fillRect(-0.5, -184, 0.7, i % 4 === 0 ? 5 : 2);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const labelFunctions = /* glsl */`
  uniform vec2 uLabelOffset;
  uniform vec2 uLabelAspect;
  uniform float uLabelScale;
  uniform float uLabelRotation;
  uniform float uLabelBlur;
  uniform float uSilver;
  vec2 labelCoordinate(vec2 uv, float angle) {
    vec2 p = (uv - .5) / max(.1, uLabelScale);
    float a = uLabelRotation + angle;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
    return p / uLabelAspect + .5 + uLabelOffset;
  }
  vec4 labelSample(sampler2D image, vec2 uv) {
    vec4 result = vec4(0.);
    for (int i = -3; i <= 3; i++) {
      vec2 coordinate = labelCoordinate(uv, float(i) * uLabelBlur / 3.);
      vec4 sampleColor = texture2D(image, clamp(coordinate, 0., 1.));
      // The supplied scan has transparent margins/hole. Treat them as unprinted
      // paper, not the black RGB values stored under the transparent pixels.
      sampleColor.rgb = mix(vec3(1.), sampleColor.rgb, sampleColor.a);
      sampleColor.a = 1.;
      float inside = step(0., coordinate.x) * step(coordinate.x, 1.) *
                     step(0., coordinate.y) * step(coordinate.y, 1.);
      result += mix(vec4(1.), sampleColor, inside);
    }
    return result / 7.;
  }
`;

// Analytic CIE 1931 fits: Wyman, Sloan & Shirley (2013), XYZ -> linear sRGB.
// g and t are transformed into WORLD space, so circular grooves are invariant
// under spin. There is deliberately no angular/time rainbow texture.
const diffractionVertex = /* glsl */`
  varying vec3 vWorld;
  varying vec3 vRadial;
  varying vec3 vTangent;
  varying vec3 vNormalWorld;
  varying vec2 vDiscUv;
  varying float vRadius;
  void main() {
    vec2 g = normalize(position.xy);
    vWorld = (modelMatrix * vec4(position, 1.)).xyz;
    vRadial = mat3(modelMatrix) * vec3(g, 0.);
    vTangent = mat3(modelMatrix) * vec3(-g.y, g.x, 0.);
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    vDiscUv = uv;
    vRadius = length(position.xy);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.);
  }
`;

const diffractionFragment = /* glsl */`
  uniform vec3 uKey;
  uniform vec3 uVirtualA;
  uniform vec3 uVirtualB;
  uniform float uSigma;
  uniform float uStrength;
  uniform float uLabelFace;
  uniform sampler2D uLabel;
  varying vec3 vWorld;
  varying vec3 vRadial;
  varying vec3 vTangent;
  varying vec3 vNormalWorld;
  varying vec2 vDiscUv;
  varying float vRadius;
  ${labelFunctions}
  vec3 spectrum(float wavelength) {
    float x1 = (wavelength - 442.) * (wavelength < 442. ? .0624 : .0374);
    float x2 = (wavelength - 599.8) * (wavelength < 599.8 ? .0264 : .0323);
    float x3 = (wavelength - 501.1) * (wavelength < 501.1 ? .049 : .0382);
    float y1 = (wavelength - 568.8) * (wavelength < 568.8 ? .0213 : .0247);
    float y2 = (wavelength - 530.9) * (wavelength < 530.9 ? .0613 : .0322);
    float z1 = (wavelength - 437.) * (wavelength < 437. ? .0845 : .0278);
    float z2 = (wavelength - 459.) * (wavelength < 459. ? .0385 : .0725);
    vec3 xyz = vec3(
      .362 * exp(-.5*x1*x1) + 1.056 * exp(-.5*x2*x2) - .065 * exp(-.5*x3*x3),
      .821 * exp(-.5*y1*y1) + .286 * exp(-.5*y2*y2),
      1.217 * exp(-.5*z1*z1) + .681 * exp(-.5*z2*z2)
    );
    vec3 rgb = vec3(
      dot(vec3(3.2406, -1.5372, -.4986), xyz),
      dot(vec3(-.9689, 1.8758, .0415), xyz),
      dot(vec3(.0557, -.2040, 1.0570), xyz)
    );
    return max(rgb, vec3(0.));
  }
  vec3 grating(vec3 lightPosition, vec3 V, vec3 g, vec3 t) {
    vec3 L = normalize(lightPosition - vWorld);
    vec3 H = L + V;
    float alignment = dot(t, H) / max(uSigma, .025);
    float envelope = exp(-alignment * alignment);
    float projected = abs(dot(g, H));
    float facing = .45 + .55 * abs(dot(vNormalWorld, L));
    vec3 color = vec3(0.);
    for (int order = 1; order <= 3; order++) {
      float m = float(order);
      float wavelength = 1600. * projected / m;
      float visible = smoothstep(380., 400., wavelength) *
                     (1. - smoothstep(710., 750., wavelength));
      color += spectrum(wavelength) * visible / (m * m);
    }
    return color * envelope * facing;
  }
  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 g = normalize(vRadial);
    vec3 t = normalize(vTangent);
    vec3 color = grating(uKey, V, g, t) * 1.5;
    color += grating(uVirtualA, V, g, t) * .85;
    color += grating(uVirtualB, V, g, t) * .65;
    float mask = smoothstep(.455, .47, vRadius) * (1. - smoothstep(1.158, 1.172, vRadius));
    if (uLabelFace > .5) {
      vec3 ink = labelSample(uLabel, vDiscUv).rgb;
      mask *= uSilver * smoothstep(.08, .85, dot(ink, vec3(.2126, .7152, .0722)));
    }
    gl_FragColor = vec4(color * uStrength * mask, mask);
  }
`;

const postShader = {
  uniforms: {
    tDiffuse: { value: null }, tBase: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uHalation: { value: .18 }, uGrain: { value: .025 }, uTime: { value: 0 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tBase;
    uniform vec2 uResolution;
    uniform float uHalation;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec4 base = texture2D(tBase, vUv);
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      vec3 glow = max(color - base.rgb, vec3(0.));
      vec2 radial = (vUv - .5) * 2. / uResolution;
      float bright = smoothstep(.7, 2., max(color.r, max(color.g, color.b)));
      color.r = mix(color.r, texture2D(tDiffuse, vUv + radial * 1.25).r, bright * uHalation);
      color.b = mix(color.b, texture2D(tDiffuse, vUv - radial * 1.25).b, bright * uHalation);
      vec3 halo = texture2D(tDiffuse, vUv + radial * 4.).rgb + texture2D(tDiffuse, vUv - radial * 4.).rgb;
      color += max(halo - 2. * base.rgb, vec3(0.)) * uHalation * .09;
      color += (hash(vUv * uResolution + fract(uTime) * 53.) - .5) * uGrain * base.a;
      // Bloom passes use opaque intermediate buffers. Restore the original
      // coverage, adding alpha only where an actual highlight halo exists.
      float alpha = clamp(base.a + max(glow.r, max(glow.g, glow.b)) * .45, 0., 1.);
      gl_FragColor = vec4(max(color, vec3(0.)) / max(alpha, .001), alpha);
    }
  `
};

export async function createDisc({
  canvas, config = {}, reducedMotion = false,
  onToggle = () => {}, onVolume = () => {}, onSplat = () => {}, onNotice = () => {}
}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = .88;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 40);
  camera.position.set(0, 0, 5.1);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .035);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();

  const keyLight = new THREE.PointLight(0xfff6e5, 5, 30, 1.4);
  keyLight.position.set(-2.8, 3.4, 4.5);
  const cyanLight = new THREE.PointLight(0x1ad1ff, 3, 20, 1.5);
  cyanLight.position.set(-3, -1, 2);
  const magentaLight = new THREE.PointLight(0xff2d95, 3, 20, 1.5);
  magentaLight.position.set(3, 2, -1);
  scene.add(keyLight, cyanLight, magentaLight, new THREE.HemisphereLight(0xd6efff, 0x34343b, .3));

  const orientation = new THREE.Group();
  const spin = new THREE.Group();
  orientation.add(spin);
  scene.add(orientation);
  const textures = makeSurfaceTextures();
  const mirror = new THREE.MeshPhysicalMaterial({
    color: 0xd9e1e5, metalness: 1, roughness: .115,
    anisotropy: .8, anisotropyMap: textures.anisotropy,
    roughnessMap: textures.roughness, envMapIntensity: .5,
    iridescence: .22, iridescenceIOR: 1.35, iridescenceThicknessRange: [90, 350],
    clearcoat: .26, clearcoatRoughness: .15
  });
  const dataFace = new THREE.Mesh(annulus(.34, 1.17), mirror);
  dataFace.position.z = .013;
  spin.add(dataFace);

  let labelTexture;
  try {
    labelTexture = await new THREE.TextureLoader().loadAsync(new URL('../assets/label.png', import.meta.url).href);
  } catch {
    // A complete typographic pressing is also a usable fallback if a user
    // replaces the image with an unavailable URL; it never blocks playback.
    const fallback = document.createElement('canvas');
    fallback.width = fallback.height = 1024;
    const ctx = fallback.getContext('2d');
    ctx.fillStyle = '#f3f0e6'; ctx.fillRect(0, 0, 1024, 1024);
    ctx.fillStyle = '#0e0e10'; ctx.textAlign = 'center';
    ctx.font = '900 110px sans-serif'; ctx.fillText('GRIND//FM', 512, 355);
    ctx.font = 'bold 32px monospace'; ctx.fillText('PIRATE FREQUENCIES / SIDE A', 512, 710);
    ctx.font = 'bold 25px monospace'; ctx.fillText('FOR THE STREETS • 20.24', 512, 758);
    labelTexture = new THREE.CanvasTexture(fallback);
    onNotice('Le label personnalisé est indisponible : le pressage GRIND//FM prend le relais.');
  }
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  labelTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const labelUniforms = {
    uLabelOffset: { value: new THREE.Vector2() }, uLabelScale: { value: 1 },
    // Preserve the source aspect ratio: this scan is 1115 × 1120, not square.
    uLabelAspect: { value: new THREE.Vector2(
      labelTexture.image.width / Math.max(labelTexture.image.width, labelTexture.image.height),
      labelTexture.image.height / Math.max(labelTexture.image.width, labelTexture.image.height)
    ) },
    uLabelRotation: { value: 0 }, uLabelBlur: { value: 0 }, uSilver: { value: 1 }
  };
  const labelMaterial = new THREE.MeshPhysicalMaterial({
    map: labelTexture, metalness: .95, roughness: .16,
    anisotropy: .5, anisotropyMap: textures.anisotropy,
    clearcoat: .6, clearcoatRoughness: .3, envMapIntensity: .6,
    iridescence: .18, iridescenceThicknessRange: [100, 320]
  });
  labelMaterial.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, labelUniforms);
    shader.fragmentShader = labelFunctions + '\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', /* glsl */`
      vec4 pressing = labelSample(map, vMapUv);
      float printedInk = 1. - smoothstep(.03, .82, dot(pressing.rgb, vec3(.2126, .7152, .0722)));
      vec3 paper = mix(vec3(.92, .90, .83), vec3(.78, .83, .88), uSilver);
      diffuseColor.rgb *= mix(paper, vec3(.012, .014, .018), printedInk);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', /* glsl */`
      float roughnessFactor = mix(mix(.48, .32, printedInk), mix(.12, .38, printedInk), uSilver);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', /* glsl */`
      float metalnessFactor = uSilver * mix(.98, .1, printedInk);
    `);
  };
  labelMaterial.customProgramCacheKey = () => 'grind-calibrated-label-v2';
  const labelFace = new THREE.Mesh(annulus(.36, 1.18), labelMaterial);
  labelFace.rotation.y = Math.PI;
  labelFace.position.z = -.013;
  spin.add(labelFace);

  const diffractionUniforms = {
    uKey: { value: keyLight.position },
    uVirtualA: { value: new THREE.Vector3(3.6, -2.2, 3.8) },
    uVirtualB: { value: new THREE.Vector3(-3.5, 1.4, -3.2) },
    uSigma: { value: .15 }, uStrength: { value: 1.4 },
    uLabelFace: { value: 0 }, uLabel: { value: labelTexture }, ...labelUniforms
  };
  const diffractionMaterial = new THREE.ShaderMaterial({
    uniforms: diffractionUniforms,
    vertexShader: diffractionVertex, fragmentShader: diffractionFragment,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    toneMapped: false
  });
  const diffractionFront = new THREE.Mesh(annulus(.46, 1.17), diffractionMaterial);
  diffractionFront.position.z = .014;
  spin.add(diffractionFront);
  const diffractionBackMaterial = diffractionMaterial.clone();
  diffractionBackMaterial.uniforms = { ...diffractionUniforms, uLabelFace: { value: 1 } };
  const diffractionBack = new THREE.Mesh(annulus(.46, 1.17), diffractionBackMaterial);
  diffractionBack.rotation.y = Math.PI;
  diffractionBack.position.z = -.014;
  spin.add(diffractionBack);

  const plastic = new THREE.MeshPhysicalMaterial({
    color: 0xdce9ed, metalness: 0, roughness: .12, transmission: 1,
    ior: 1.58, thickness: .024, transparent: true, opacity: .76,
    envMapIntensity: 1.2, iridescence: .18, iridescenceThicknessRange: [120, 220],
    side: THREE.DoubleSide, depthWrite: false
  });
  const hub = new THREE.Mesh(annulus(.15, .34), plastic);
  hub.position.z = .015;
  spin.add(hub);
  const substrate = new THREE.Mesh(annulus(1.17, 1.2), plastic);
  spin.add(substrate);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.193, .007, 8, SEGMENTS), plastic);
  const stackingRing = new THREE.Mesh(new THREE.TorusGeometry(.295, .007, 8, SEGMENTS), plastic);
  stackingRing.position.z = .018;
  spin.add(rim, stackingRing);
  const silverEdge = new THREE.Mesh(new THREE.CylinderGeometry(1.185, 1.185, .018, SEGMENTS, 1, true), mirror);
  silverEdge.rotation.x = Math.PI / 2;
  spin.add(silverEdge);
  const holeWall = new THREE.Mesh(new THREE.CylinderGeometry(.15, .15, .024, SEGMENTS, 1, true), plastic);
  holeWall.rotation.x = Math.PI / 2;
  spin.add(holeWall);

  const ink = new THREE.MeshBasicMaterial({ color: 0x0e0e10, side: THREE.DoubleSide });
  spin.add(new THREE.Mesh(new THREE.TorusGeometry(1.205, .0075, 8, SEGMENTS), ink));
  spin.add(new THREE.Mesh(new THREE.TorusGeometry(.15, .006, 8, SEGMENTS), ink));
  const matrixTexture = makeMatrixTexture();
  const matrixMaterial = new THREE.MeshBasicMaterial({ map: matrixTexture, transparent: true, depthWrite: false });
  const matrix = new THREE.Mesh(annulus(.35, .455), matrixMaterial);
  matrix.position.z = .015;
  spin.add(matrix);
  const matrixBack = matrix.clone();
  matrixBack.rotation.y = Math.PI;
  matrixBack.position.z = -.015;
  spin.add(matrixBack);

  // A linear HDR pipeline, with the base coverage saved before bloom so the
  // skyline behind the transparent WebGL canvas remains visible.
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const savePass = new SavePass();
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), .42, .45, 1.75);
  // Studio softboxes are extremely bright in the PMREM. Limit only the
  // radiance sent into bloom; keep the original mirror's HDR reflections.
  bloomPass.materialHighPassFilter.fragmentShader = bloomPass.materialHighPassFilter.fragmentShader.replace(
    'gl_FragColor = mix( outputColor, texel, alpha );',
    'texel.rgb *= min(1., 3. / max(.001, max(texel.r, max(texel.g, texel.b)))); gl_FragColor = mix( outputColor, texel, alpha );'
  );
  const postPass = new ShaderPass(postShader);
  postPass.uniforms.tBase.value = savePass.renderTarget.texture;
  const outputPass = new OutputPass();
  [renderPass, savePass, bloomPass, postPass, outputPass].forEach(pass => composer.addPass(pass));

  let width = 1, height = 1, lowQuality = false, disposed = false;
  let speed = 0, speedVelocity = 0, spinAngle = 0;
  let precession = config.disc?.initialFace === 'label' ? Math.PI : 0;
  let flipAngle = 0, flipTarget = 0, flipVelocity = 0, flash = 0;
  let releasedAt = -10000, dragging = false, pointerDown = null;
  let labelMode = config.label?.mode || 'silver';
  const pointer = new THREE.Vector2(), pointerSmooth = new THREE.Vector2();
  const automatic = new THREE.Quaternion(), userRotation = new THREE.Quaternion();
  const inertia = new THREE.Vector2();
  const arcStart = new THREE.Vector3(), arcCurrent = new THREE.Vector3();
  const dragQuaternion = new THREE.Quaternion(), dragBase = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickDisc = new THREE.Mesh(annulus(.15, 1.21), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  pickDisc.visible = false;
  orientation.add(pickDisc);
  const screenPoint = new THREE.Vector3();
  const screenEdge = new THREE.Vector3();
  const reflectionOrigin = new THREE.Vector3();
  const reflectionNormal = new THREE.Vector3();
  const reflectionDirection = new THREE.Vector3();
  const reflectionPoint = new THREE.Vector3();

  function resize() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, config.rendering?.dpr || 2, lowQuality ? 1.25 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    camera.aspect = width / height;
    // Roughly 210 px radius in a 650 × 500 px stage, with safe mobile margins.
    const radiusPx = Math.min(height * .425, width * .405);
    camera.position.z = RADIUS * height / (2 * Math.max(1, radiusPx) * Math.tan(THREE.MathUtils.degToRad(camera.fov * .5)));
    camera.updateProjectionMatrix();
    postPass.uniforms.uResolution.value.set(width * dpr, height * dpr);
  }

  function getScreenDisc() {
    const rect = canvas.getBoundingClientRect();
    orientation.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    screenPoint.setFromMatrixPosition(orientation.matrixWorld).project(camera);
    screenEdge.set(RADIUS, 0, orientation.position.z).project(camera);
    const radius = Math.abs(screenEdge.x - screenPoint.x) * width / 2;
    // A real reflected ray hits the backdrop only at the appropriate tilt.
    // Returning zero intensity for a forward ray prevents impossible glows.
    reflectionOrigin.setFromMatrixPosition(orientation.matrixWorld);
    reflectionNormal.set(0, 0, 1).applyQuaternion(orientation.quaternion).normalize();
    reflectionDirection.copy(reflectionOrigin).sub(keyLight.position).normalize().reflect(reflectionNormal);
    const travel = (-1.5 - reflectionOrigin.z) / reflectionDirection.z;
    const reflectionVisible = reflectionDirection.z < -.04 && travel > 0 && travel < 16;
    reflectionPoint.copy(reflectionOrigin).addScaledVector(reflectionDirection, reflectionVisible ? travel : 0).project(camera);
    const reflection = {
      x: rect.left + (reflectionPoint.x * .5 + .5) * width,
      y: rect.top + (-reflectionPoint.y * .5 + .5) * height,
      angle: Math.atan2(-reflectionDirection.y, reflectionDirection.x),
      intensity: reflectionVisible ? clamp(-reflectionDirection.z * .85, 0, .7) : 0
    };
    return { x: rect.left + (screenPoint.x * .5 + .5) * width, y: rect.top + (-screenPoint.y * .5 + .5) * height, radius, reflection };
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    ndc.set((clientX - rect.left) / width * 2 - 1, -(clientY - rect.top) / height * 2 + 1);
    orientation.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObject(pickDisc, false).length > 0;
  }

  function arcball(clientX, clientY, target) {
    const disc = getScreenDisc();
    target.set((clientX - disc.x) / disc.radius, -(clientY - disc.y) / disc.radius, 0);
    const lengthSq = target.x * target.x + target.y * target.y;
    target.z = lengthSq <= .5 ? Math.sqrt(1 - lengthSq) : .5 / Math.sqrt(lengthSq);
    return target.normalize();
  }

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(clamp((event.clientX - rect.left) / width * 2 - 1, -1, 1), clamp(-(event.clientY - rect.top) / height * 2 + 1, -1, 1));
    if (!pointerDown || event.pointerId !== pointerDown.id) return;
    const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    pointerDown.distance = Math.max(pointerDown.distance, distance);
    if (pointerDown.outside) return;
    if (!dragging && distance > 6) dragging = true;
    if (dragging) {
      arcball(event.clientX, event.clientY, arcCurrent);
      dragQuaternion.setFromUnitVectors(arcStart, arcCurrent);
      orientation.quaternion.copy(dragQuaternion).multiply(dragBase);
      userRotation.copy(orientation.quaternion);
      const elapsed = Math.max(.008, (performance.now() - pointerDown.lastTime) / 1000);
      inertia.set((event.clientY - pointerDown.lastY) / height / elapsed * 2, (event.clientX - pointerDown.lastX) / width / elapsed * 2).clampLength(0, 3);
      pointerDown.lastX = event.clientX; pointerDown.lastY = event.clientY; pointerDown.lastTime = performance.now();
      canvas.classList.add('is-dragging');
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (!hitTest(event.clientX, event.clientY)) {
      pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), distance: 0, outside: true };
      return;
    }
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    const now = performance.now();
    pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, time: now, lastTime: now, lastX: event.clientX, lastY: event.clientY };
    dragging = false;
    dragBase.copy(orientation.quaternion);
    arcball(event.clientX, event.clientY, arcStart);
    inertia.set(0, 0);
    canvas.setPointerCapture(event.pointerId);
  }

  function onPointerUp(event) {
    if (!pointerDown || event.pointerId !== pointerDown.id) return;
    const isClick = pointerDown.distance < 6 && performance.now() - pointerDown.time < 300;
    if (pointerDown.outside) {
      pointerDown = null;
      if (isClick && event.type !== 'pointercancel') onSplat(event.clientX, event.clientY);
      return;
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (dragging) {
      releasedAt = performance.now() / 1000;
      userRotation.copy(orientation.quaternion);
    }
    pointerDown = null; dragging = false;
    canvas.classList.remove('is-dragging');
    // Deliberately synchronous: YouTube receives the original user gesture.
    if (isClick && event.type !== 'pointercancel') onToggle();
  }

  function onWheel(event) {
    if (!hitTest(event.clientX, event.clientY)) return;
    event.preventDefault();
    onVolume(event.deltaY < 0 ? 5 : -5);
  }

  function applyConfig() {
    const label = config.label || {};
    labelUniforms.uLabelOffset.value.set(label.offsetX || 0, label.offsetY || 0);
    labelUniforms.uLabelScale.value = label.scale || 1;
    labelUniforms.uLabelRotation.value = (label.rotation || 0) * Math.PI / 180;
    labelUniforms.uSilver.value = labelMode === 'silver' ? 1 : 0;
    diffractionUniforms.uSigma.value = config.fx?.sigma ?? .15;
    keyLight.intensity = config.lights?.key ?? 5;
    cyanLight.intensity = config.lights?.rim ?? 3;
    magentaLight.intensity = config.lights?.rim ?? 3;
    const tone = config.rendering?.toneMapping || 'Neutral';
    renderer.toneMapping = tone === 'AgX' ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
  }

  function update(dt, time, features = {}, playback = {}) {
    if (disposed || document.hidden) return;
    dt = Math.min(Math.max(dt || .016, .001), .05);
    const playing = playback.playing ?? (playback.state === 1 || playback.state === 'playing');
    const buffering = playback.buffering ?? (playback.state === 3 || playback.state === 'buffering');
    const bass = clamp(features.bass || 0, 0, 1);
    const level = clamp(features.level || 0, 0, 1);
    const kick = clamp(features.kick || 0, 0, 1);
    const motion = reducedMotion ? .12 : 1;
    const targetSpeed = (playing ? (config.disc?.playSpeed ?? 2) * (1 + bass * .045) : (config.disc?.idleSpeed ?? .06)) * TAU * motion;
    speedVelocity += ((targetSpeed - speed) * 22 - speedVelocity * 9.2) * dt;
    speed += speedVelocity * dt;
    spinAngle = (spinAngle + speed * dt) % TAU;
    spin.rotation.z = spinAngle;
    labelUniforms.uLabelBlur.value = Math.max(0, Math.abs(speed) - TAU * 1.5) * .026;
    pointerSmooth.lerp(pointer, 1 - Math.exp(-3.4 * dt));
    keyLight.position.x = damp(keyLight.position.x, -2.8 + pointerSmooth.x * 4.5, 4, dt);
    keyLight.position.y = damp(keyLight.position.y, 3.4 + pointerSmooth.y * 3, 4, dt);
    precession += (config.disc?.precessionSpeed ?? .11) * dt * motion;
    flipVelocity += ((flipTarget - flipAngle) * 38 - flipVelocity * 9) * dt;
    flipAngle += flipVelocity * dt;
    const wobble = buffering && !reducedMotion ? Math.sin(time * 10) * .035 : 0;
    euler.set(-.2 + Math.sin(time * .34) * .13 * motion + pointerSmooth.y * .14 + wobble,
      -.22 + precession + pointerSmooth.x * .16 + flipAngle,
      Math.sin(time * .27) * .08 * motion);
    automatic.setFromEuler(euler);
    if (!dragging) {
      const sinceRelease = performance.now() / 1000 - releasedAt;
      if (sinceRelease < 2) {
        euler.set(inertia.x * dt, inertia.y * dt, 0);
        dragQuaternion.setFromEuler(euler);
        userRotation.premultiply(dragQuaternion);
        inertia.multiplyScalar(Math.exp(-3.7 * dt));
        orientation.quaternion.copy(userRotation);
      } else {
        orientation.quaternion.slerp(automatic, 1 - Math.exp(-2.5 * dt));
      }
    }
    orientation.position.y = Math.sin(time * .7) * .035 * motion;
    orientation.scale.setScalar(1 + (reducedMotion ? 0 : kick * .016));
    camera.rotation.z = reducedMotion ? 0 : Math.sin(time * .5) * (features.mid || 0) * .004;
    flash = Math.max(0, flash - dt * 2);
    applyConfig();
    diffractionUniforms.uStrength.value = (config.fx?.diffraction ?? 1.4) * (1 + level * .12 + flash * .32);
    bloomPass.strength = (config.fx?.bloom ?? .42) * (1 + level * .24 + kick * .12);
    postPass.uniforms.uHalation.value = lowQuality ? 0 : (config.fx?.halation ?? .18);
    postPass.uniforms.uGrain.value = config.fx?.grain ?? .025;
    postPass.uniforms.uTime.value = reducedMotion ? 0 : time;
    composer.render(dt);
  }

  function setLabelMode(mode) {
    labelMode = mode === 'white' ? 'white' : 'silver';
    if (config.label) config.label.mode = labelMode;
    labelUniforms.uSilver.value = labelMode === 'silver' ? 1 : 0;
  }

  function flip() { flipTarget += Math.PI; flash = reducedMotion ? 0 : 1; }
  function setQuality(low) {
    if (lowQuality === Boolean(low)) return;
    lowQuality = Boolean(low); resize();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  applyConfig();
  orientation.rotation.set(-.2, -.22 + precession, -.04);
  resize();
  // Compile eagerly so shader errors are reported during startup, before play.
  renderer.compile(scene, camera);
  composer.render(0);

  function dispose() {
    if (disposed) return;
    disposed = true;
    resizeObserver.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    [textures.anisotropy, textures.roughness, matrixTexture, labelTexture].forEach(texture => texture.dispose());
    environment.dispose();
    composer.passes.forEach(pass => pass.dispose?.());
    composer.dispose(); renderer.dispose();
  }

  return {
    update, resize, hitTest, setLabelMode, flip, getScreenDisc, setQuality, dispose,
    debug: { renderer, scene, camera, orientation, spin, bloomPass, postPass, diffractionUniforms, labelUniforms, keyLight, cyanLight, magentaLight, applyConfig }
  };
}
