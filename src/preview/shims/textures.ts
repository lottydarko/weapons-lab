import * as THREE from 'three';

export interface TextureLibrary {
  pedFaceSkinMap: THREE.Texture;
  pedFaceWeatheredMap: THREE.Texture;
  pedFaceBump: THREE.Texture;
  pedClothingMap: THREE.Texture;
  pedClothingRoughness: THREE.Texture;
  pedClothingBump: THREE.Texture;
  pedFabricLeatherMap: THREE.Texture;
  pedFabricLeatherRoughness: THREE.Texture;
  pedFabricLeatherBump: THREE.Texture;
  pedFabricKnitMap: THREE.Texture;
  pedFabricKnitRoughness: THREE.Texture;
  pedFabricKnitBump: THREE.Texture;
  pedFabricDenimMap: THREE.Texture;
  pedFabricDenimRoughness: THREE.Texture;
  pedFabricDenimBump: THREE.Texture;
  pedHairMap: THREE.Texture;
  pedHairBump: THREE.Texture;
  newspaperMap: THREE.Texture;
  phoneScreenMap: THREE.Texture;
  [key: string]: THREE.Texture;
}

function makeFabricCanvasTex(baseHex: string, grainAmp: number, isColor = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 2) {
    for (let x = 0; x < 64; x += 2) {
      const v = Math.floor(128 + ((Math.sin(x * 1.7 + y * 2.3) * 0.5 + 0.5) - 0.5) * grainAmp);
      ctx.fillStyle = `rgba(${v},${v},${v},0.16)`;
      ctx.fillRect(x, y, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createPreviewTextureLibrary(): TextureLibrary {
  const skin = makeFabricCanvasTex('#d7b199', 18, true);
  const weathered = makeFabricCanvasTex('#c79f87', 26, true);
  const cloth = makeFabricCanvasTex('#d4d8df', 28, true);
  const leather = makeFabricCanvasTex('#b8bcc4', 20, true);
  const knit = makeFabricCanvasTex('#d0d3d9', 42, true);
  const denim = makeFabricCanvasTex('#c6ccd8', 36, true);
  const hair = makeFabricCanvasTex('#c4c4c4', 44, true);
  const rough = makeFabricCanvasTex('#c8c8c8', 24, false);
  const bump = makeFabricCanvasTex('#808080', 36, false);
  const paper = makeFabricCanvasTex('#d8d2c2', 18, true);
  const phone = makeFabricCanvasTex('#1d2c3f', 12, true);

  return {
    pedFaceSkinMap: skin,
    pedFaceWeatheredMap: weathered,
    pedFaceBump: bump,
    pedClothingMap: cloth,
    pedClothingRoughness: rough,
    pedClothingBump: bump,
    pedFabricLeatherMap: leather,
    pedFabricLeatherRoughness: rough,
    pedFabricLeatherBump: bump,
    pedFabricKnitMap: knit,
    pedFabricKnitRoughness: rough,
    pedFabricKnitBump: bump,
    pedFabricDenimMap: denim,
    pedFabricDenimRoughness: rough,
    pedFabricDenimBump: bump,
    pedHairMap: hair,
    pedHairBump: bump,
    newspaperMap: paper,
    phoneScreenMap: phone,
  };
}
