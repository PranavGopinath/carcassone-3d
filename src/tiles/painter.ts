import {
  DECK,
  DirIndex,
  EdgeType,
  getRotatedEdgeLevels,
  getRotatedEdges,
  PALETTE,
  RGB,
  Rotation,
  TileSpec,
} from '../contracts';

function rgbStr(c: RGB): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/**
 * Computes (x, y) for clockwise parameter `u in [0, 1]` along `side` (0=N, 1=E, 2=S, 3=W)
 * and `inset` pixels from the outer tile border.
 */
function edgePointCW(side: DirIndex, u: number, inset: number, size: number): { x: number; y: number } {
  switch (side) {
    case 0: // North: West (u=0) -> East (u=1)
      return { x: u * size, y: inset };
    case 1: // East: North (u=0) -> South (u=1)
      return { x: size - inset, y: u * size };
    case 2: // South: East (u=0) -> West (u=1)
      return { x: (1 - u) * size, y: size - inset };
    case 3: // West: South (u=0) -> North (u=1)
      return { x: inset, y: (1 - u) * size };
  }
}

/**
 * Deterministic hash in [0, 1) from string + integer index.
 */
function hash01(seedStr: string, idx: number): number {
  let h = 2166136261 ^ idx;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Rotates a local offset (dx, dy) around the origin by `rotation * 90°` CW.
 */
function rotateVec(dx: number, dy: number, rotation: Rotation): { x: number; y: number } {
  const r = ((rotation % 4) + 4) % 4;
  switch (r) {
    case 0:
      return { x: dx, y: dy };
    case 1:
      return { x: -dy, y: dx };
    case 2:
      return { x: -dx, y: -dy };
    default:
      return { x: dy, y: -dx };
  }
}

/**
 * Draws the interior grass texture, organic meadow patches, grass blade tufts, canopy clusters,
 * and hill/plateau contour terraces strictly within `inset >= 9px` so outer edge sockets remain pure PALETTE colors.
 */
function drawInteriorGrassAndContours(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  rotation: Rotation,
  levels: [number, number, number, number],
  size: number
): void {
  const margin = Math.max(9, Math.round(0.036 * size));
  const half = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(margin, margin, size - margin * 2, size - margin * 2);
  ctx.clip();

  // Warm sunlight gradient across meadow (top-right sunlit, bottom-left deeper green)
  const sunGrad = ctx.createLinearGradient(size * 0.85, size * 0.1, size * 0.15, size * 0.9);
  sunGrad.addColorStop(0, 'rgba(154, 204, 92, 0.34)');
  sunGrad.addColorStop(0.5, 'rgba(108, 166, 76, 0.0)');
  sunGrad.addColorStop(1, 'rgba(64, 114, 42, 0.32)');
  ctx.fillStyle = sunGrad;
  ctx.fillRect(margin, margin, size - margin * 2, size - margin * 2);

  // Subtle mowing / terrain contour bands rotated with the tile
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate((rotation * Math.PI) / 2 + 0.35);
  const stripeW = size * 0.075;
  for (let i = -9; i <= 9; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(132, 188, 86, 0.16)' : 'rgba(82, 136, 54, 0.15)';
    ctx.fillRect(i * stripeW, -size, stripeW * 0.52, size * 2);
  }
  ctx.restore();

  // Organic dappled meadow patches
  for (let i = 0; i < 28; i++) {
    const rx = (hash01(spec.id, i * 3 + 10) - 0.5) * (size - margin * 2.4);
    const ry = (hash01(spec.id, i * 3 + 11) - 0.5) * (size - margin * 2.4);
    const rad = size * (0.04 + hash01(spec.id, i * 3 + 12) * 0.07);
    const rotPt = rotateVec(rx, ry, rotation);
    const gx = half + rotPt.x;
    const gy = half + rotPt.y;
    const patchGrad = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
    if (i % 2 === 0) {
      patchGrad.addColorStop(0, 'rgba(148, 202, 88, 0.28)');
      patchGrad.addColorStop(1, 'rgba(148, 202, 88, 0)');
    } else {
      patchGrad.addColorStop(0, 'rgba(66, 118, 42, 0.26)');
      patchGrad.addColorStop(1, 'rgba(66, 118, 42, 0)');
    }
    ctx.fillStyle = patchGrad;
    ctx.beginPath();
    ctx.arc(gx, gy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine deterministic grass blade tufts & meadow shrubs
  for (let i = 0; i < 42; i++) {
    const rx = (hash01(spec.id, i * 2) - 0.5) * (size - margin * 2.6);
    const ry = (hash01(spec.id, i * 2 + 1) - 0.5) * (size - margin * 2.6);
    const rotPt = rotateVec(rx, ry, rotation);
    const gx = half + rotPt.x;
    const gy = half + rotPt.y;

    // Tiny shadow under tuft
    ctx.fillStyle = 'rgba(38, 68, 24, 0.28)';
    ctx.beginPath();
    ctx.arc(gx + size * 0.004, gy + size * 0.005, size * 0.013, 0, Math.PI * 2);
    ctx.fill();

    // Sunlit tuft
    ctx.fillStyle = i % 3 === 0 ? '#8ec654' : i % 3 === 1 ? '#528836' : '#72b046';
    ctx.beginPath();
    ctx.arc(gx, gy, size * 0.011, 0, Math.PI * 2);
    ctx.fill();
  }

  // Elevation terrace contours for GRASS_HILL and GRASS_PLATEAU with rocky earth ledges
  if (spec.special === 'GRASS_HILL') {
    for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
      if (levels[s] > 0) {
        const mid = edgePointCW(s, 0.5, margin + 4, size);
        for (let step = 3; step >= 1; step--) {
          const r = size * (0.16 + step * 0.11);
          ctx.beginPath();
          ctx.arc(mid.x, mid.y, r, 0, Math.PI * 2);
          ctx.fillStyle =
            step === 1
              ? 'rgba(148, 202, 98, 0.52)'
              : step === 2
                ? 'rgba(128, 186, 84, 0.44)'
                : 'rgba(112, 170, 74, 0.36)';
          ctx.fill();
          ctx.lineWidth = Math.max(2, size * 0.012);
          ctx.strokeStyle = 'rgba(116, 86, 56, 0.62)';
          ctx.stroke();
        }
      }
    }
  } else if (spec.special === 'GRASS_PLATEAU') {
    for (let step = 3; step >= 1; step--) {
      const insetStep = margin + (4 - step) * (size * 0.055);
      const w = size - insetStep * 2;
      ctx.fillStyle =
        step === 1
          ? 'rgba(150, 204, 102, 0.46)'
          : step === 2
            ? 'rgba(130, 188, 88, 0.38)'
            : 'rgba(114, 172, 78, 0.30)';
      ctx.strokeStyle = 'rgba(116, 86, 56, 0.62)';
      ctx.lineWidth = Math.max(2, size * 0.01);
      ctx.beginPath();
      ctx.rect(insetStep, insetStep, w, w);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Draws CITY segments, corner merges, realistic limestone battlements, round blue-roofed towers,
 * and dense medieval terracotta/slate town roofs matching `reference/Design_of_game.jpeg`.
 */
function drawCities(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  size: number
): void {
  const citySides: DirIndex[] = [];
  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    if (edges[s] === 'CITY') {
      citySides.push(s);
    }
  }
  if (citySides.length === 0) return;

  const depth = 0.34 * size;
  const half = size / 2;

  // 1. Fill individual city edge bands with canonical PALETTE.CITY base
  ctx.fillStyle = rgbStr(PALETTE.CITY);
  for (const s of citySides) {
    const prevSide = ((s + 3) % 4) as DirIndex;
    const nextSide = ((s + 1) % 4) as DirIndex;
    const prevCity = edges[prevSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';
    const nextCity = edges[nextSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';

    const u0 = prevCity ? 0.0 : 0.06;
    const u1 = nextCity ? 1.0 : 0.94;

    const pStart = edgePointCW(s, u0, 0, size);
    const pEnd = edgePointCW(s, u1, 0, size);
    const pInnerEnd = edgePointCW(s, nextCity ? 1.0 : 0.86, nextCity ? depth : depth * 0.82, size);
    const pInnerMid = edgePointCW(s, 0.5, depth, size);
    const pInnerStart = edgePointCW(s, prevCity ? 0.0 : 0.14, prevCity ? depth : depth * 0.82, size);

    ctx.beginPath();
    ctx.moveTo(pStart.x, pStart.y);
    ctx.lineTo(pEnd.x, pEnd.y);
    ctx.lineTo(pInnerEnd.x, pInnerEnd.y);
    ctx.quadraticCurveTo(pInnerMid.x, pInnerMid.y, pInnerStart.x, pInnerStart.y);
    ctx.closePath();
    ctx.fill();
  }

  // 2. If multiple edges are CITY and not CITY_SEPARATE, connect them smoothly across the interior
  if (citySides.length >= 2 && spec.special !== 'CITY_SEPARATE') {
    ctx.fillStyle = rgbStr(PALETTE.CITY);
    ctx.beginPath();
    for (let i = 0; i < citySides.length; i++) {
      const s = citySides[i];
      const prevSide = ((s + 3) % 4) as DirIndex;
      const nextSide = ((s + 1) % 4) as DirIndex;
      const u0 = edges[prevSide] === 'CITY' ? 0.0 : 0.06;
      const u1 = edges[nextSide] === 'CITY' ? 1.0 : 0.94;
      const p0 = edgePointCW(s, u0, 0, size);
      const p1 = edgePointCW(s, u1, 0, size);
      if (i === 0) {
        ctx.moveTo(p0.x, p0.y);
      } else {
        ctx.lineTo(p0.x, p0.y);
      }
      ctx.lineTo(p1.x, p1.y);
    }
    if (citySides.length >= 3) {
      ctx.lineTo(half, half);
    }
    ctx.closePath();
    ctx.fill();
  }

  // 3. Draw interior fortified wall rims, round towers, pitched medieval roofs (strictly inset >= 9px)
  const interiorMargin = Math.max(9, Math.round(0.036 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(interiorMargin, interiorMargin, size - interiorMargin * 2, size - interiorMargin * 2);
  ctx.clip();

  // Helper to paint a pitched medieval roof with sunlit and shaded slopes
  const drawPitchedHouseRoof = (cx: number, cy: number, w: number, h: number, angle: number, isBlue = false) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Drop shadow
    ctx.fillStyle = 'rgba(28, 18, 12, 0.38)';
    ctx.fillRect(-w / 2 + size * 0.008, -h / 2 + size * 0.008, w, h);

    // Sunlit upper slope
    ctx.fillStyle = isBlue ? '#5b769e' : '#d4653b';
    ctx.fillRect(-w / 2, -h / 2, w, h * 0.5);

    // Shaded lower slope
    ctx.fillStyle = isBlue ? '#3e5373' : '#9e3f22';
    ctx.fillRect(-w / 2, 0, w, h * 0.5);

    // Roof outline & ridge line
    ctx.strokeStyle = '#3b2314';
    ctx.lineWidth = Math.max(1, size * 0.004);
    ctx.strokeRect(-w / 2, -h / 2, w, h);

    ctx.strokeStyle = isBlue ? '#93b4db' : '#f29a72';
    ctx.lineWidth = Math.max(1, size * 0.005);
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.stroke();

    ctx.restore();
  };

  for (const s of citySides) {
    const prevSide = ((s + 3) % 4) as DirIndex;
    const nextSide = ((s + 1) % 4) as DirIndex;
    const prevCity = edges[prevSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';
    const nextCity = edges[nextSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';

    // Dense medieval houses inside the city sector
    const baseAngle = (s * Math.PI) / 2;
    for (const [idx, u] of [0.2, 0.35, 0.5, 0.65, 0.8].entries()) {
      const rowInset = size * (idx % 2 === 0 ? 0.14 : 0.21);
      const roofCenter = edgePointCW(s, u, rowInset, size);
      const rW = size * (idx === 2 ? 0.105 : 0.085);
      const rH = size * 0.062;
      drawPitchedHouseRoof(
        roofCenter.x,
        roofCenter.y,
        rW,
        rH,
        baseAngle + (idx % 2 === 0 ? 0.08 : -0.12),
        idx === 1 || idx === 3
      );
    }

    // Inner fortified limestone wall & blue-coned round towers
    if (citySides.length === 1 || spec.special === 'CITY_SEPARATE' || citySides.length === 2) {
      const pInnerStart = edgePointCW(s, prevCity ? 0.10 : 0.08, depth * 0.9, size);
      const pInnerMid = edgePointCW(s, 0.5, depth * 0.98, size);
      const pInnerEnd = edgePointCW(s, nextCity ? 0.90 : 0.92, depth * 0.9, size);

      // Wall outer shadow onto meadow
      ctx.beginPath();
      ctx.moveTo(pInnerStart.x, pInnerStart.y);
      ctx.quadraticCurveTo(pInnerMid.x, pInnerMid.y, pInnerEnd.x, pInnerEnd.y);
      ctx.strokeStyle = 'rgba(30, 42, 20, 0.42)';
      ctx.lineWidth = Math.max(5, size * 0.036);
      ctx.stroke();

      // Limestone curtain wall
      ctx.beginPath();
      ctx.moveTo(pInnerStart.x, pInnerStart.y);
      ctx.quadraticCurveTo(pInnerMid.x, pInnerMid.y, pInnerEnd.x, pInnerEnd.y);
      ctx.strokeStyle = '#dfd3be';
      ctx.lineWidth = Math.max(3.5, size * 0.024);
      ctx.stroke();

      // Crenellation merlons & round conical-roofed bastion towers along the wall
      for (const [tIdx, tu] of [0.16, 0.33, 0.5, 0.67, 0.84].entries()) {
        const mp = edgePointCW(s, tu, depth * 0.92, size);
        if (tIdx % 2 === 0) {
          // Cylindrical tower with conical blue slate roof (matching Design_of_game.jpeg)
          const tRad = size * 0.028;
          ctx.fillStyle = 'rgba(20, 24, 32, 0.35)';
          ctx.beginPath();
          ctx.arc(mp.x + size * 0.005, mp.y + size * 0.005, tRad * 1.1, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#e5dac6';
          ctx.beginPath();
          ctx.arc(mp.x, mp.y, tRad, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#486288';
          ctx.beginPath();
          ctx.arc(mp.x, mp.y, tRad * 0.78, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#7fa1cc';
          ctx.beginPath();
          ctx.arc(mp.x - tRad * 0.2, mp.y - tRad * 0.2, tRad * 0.3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const mSize = size * 0.022;
          ctx.fillStyle = '#ede4d4';
          ctx.fillRect(mp.x - mSize / 2, mp.y - mSize / 2, mSize, mSize);
        }
      }
    }
  }

  // If 3-edge stronghold, draw a central citadel keep plaza
  if (citySides.length >= 3) {
    drawPitchedHouseRoof(half, half, size * 0.16, size * 0.11, 0.2, false);
    drawPitchedHouseRoof(half - size * 0.1, half + size * 0.08, size * 0.11, size * 0.08, -0.4, true);
    drawPitchedHouseRoof(half + size * 0.1, half - size * 0.07, size * 0.11, size * 0.08, 0.5, false);
  }

  ctx.restore();
}

/**
 * Draws WATER river segments (20% tile width = 0.20 * size) from edge midpoints to tile center.
 */
function drawRivers(
  ctx: CanvasRenderingContext2D,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  size: number
): void {
  const waterSides: DirIndex[] = [];
  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    if (edges[s] === 'WATER') {
      waterSides.push(s);
    }
  }
  if (waterSides.length === 0) return;

  const wWater = 0.2 * size;
  const half = size / 2;
  const bankMargin = Math.max(8, Math.round(0.032 * size));

  const traceRiverPath = () => {
    ctx.beginPath();
    if (waterSides.length === 2 && (waterSides[0] + 2) % 4 === waterSides[1]) {
      // Opposite edges: straight line
      const p0 = edgePointCW(waterSides[0], 0.5, 0, size);
      const p1 = edgePointCW(waterSides[1], 0.5, 0, size);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    } else if (waterSides.length === 2) {
      // Adjacent edges: straight socket entry + smooth quadratic curve through center
      const p0Out = edgePointCW(waterSides[0], 0.5, 0, size);
      const p0In = edgePointCW(waterSides[0], 0.5, bankMargin, size);
      const p1In = edgePointCW(waterSides[1], 0.5, bankMargin, size);
      const p1Out = edgePointCW(waterSides[1], 0.5, 0, size);
      ctx.moveTo(p0Out.x, p0Out.y);
      ctx.lineTo(p0In.x, p0In.y);
      ctx.quadraticCurveTo(half, half, p1In.x, p1In.y);
      ctx.lineTo(p1Out.x, p1Out.y);
    } else {
      // 1, 3, or 4 edges: connect each water edge midpoint to center
      for (const s of waterSides) {
        const p = edgePointCW(s, 0.5, 0, size);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(half, half);
      }
    }
  };

  // 1. Interior river bank outline & sandy shallows (clipped to interior >= bankMargin so edge sockets stay clean)
  ctx.save();
  ctx.beginPath();
  ctx.rect(bankMargin, bankMargin, size - bankMargin * 2, size - bankMargin * 2);
  ctx.clip();

  traceRiverPath();
  ctx.strokeStyle = 'rgba(42, 78, 36, 0.55)';
  ctx.lineWidth = wWater + Math.max(6, size * 0.044);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  traceRiverPath();
  ctx.strokeStyle = '#9e9275';
  ctx.lineWidth = wWater + Math.max(3, size * 0.022);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  // 2. Main PALETTE.WATER fill
  traceRiverPath();
  ctx.strokeStyle = rgbStr(PALETTE.WATER);
  ctx.lineWidth = wWater;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (waterSides.length >= 3 || waterSides.length === 1) {
    ctx.fillStyle = rgbStr(PALETTE.WATER);
    ctx.beginPath();
    ctx.arc(half, half, wWater * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. Deep channel & shimmering water flow highlights (strictly clipped to interior >= 11px)
  const rippleMargin = Math.max(11, Math.round(0.045 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(rippleMargin, rippleMargin, size - rippleMargin * 2, size - rippleMargin * 2);
  ctx.clip();

  traceRiverPath();
  ctx.strokeStyle = 'rgba(28, 92, 152, 0.42)';
  ctx.lineWidth = wWater * 0.55;
  ctx.lineCap = 'round';
  ctx.stroke();

  traceRiverPath();
  ctx.strokeStyle = 'rgba(165, 224, 255, 0.42)';
  ctx.lineWidth = wWater * 0.2;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws ROAD segments (16% tile width = 0.16 * size) from edge midpoints to tile center.
 * Drawn AFTER rivers so bridges carry the road cleanly over the water.
 */
function drawRoads(
  ctx: CanvasRenderingContext2D,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  size: number
): void {
  const roadSides: DirIndex[] = [];
  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    if (edges[s] === 'ROAD') {
      roadSides.push(s);
    }
  }
  if (roadSides.length === 0) return;

  const wRoad = 0.16 * size;
  const half = size / 2;
  const vergeMargin = Math.max(8, Math.round(0.032 * size));

  const traceRoadPath = () => {
    ctx.beginPath();
    if (roadSides.length === 2 && (roadSides[0] + 2) % 4 === roadSides[1]) {
      const p0 = edgePointCW(roadSides[0], 0.5, 0, size);
      const p1 = edgePointCW(roadSides[1], 0.5, 0, size);
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    } else if (roadSides.length === 2) {
      const p0Out = edgePointCW(roadSides[0], 0.5, 0, size);
      const p0In = edgePointCW(roadSides[0], 0.5, vergeMargin, size);
      const p1In = edgePointCW(roadSides[1], 0.5, vergeMargin, size);
      const p1Out = edgePointCW(roadSides[1], 0.5, 0, size);
      ctx.moveTo(p0Out.x, p0Out.y);
      ctx.lineTo(p0In.x, p0In.y);
      ctx.quadraticCurveTo(half, half, p1In.x, p1In.y);
      ctx.lineTo(p1Out.x, p1Out.y);
    } else {
      for (const s of roadSides) {
        const p = edgePointCW(s, 0.5, 0, size);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(half, half);
      }
    }
  };

  // 1. Interior road grass shadow & stone curb (clipped to >= vergeMargin)
  ctx.save();
  ctx.beginPath();
  ctx.rect(vergeMargin, vergeMargin, size - vergeMargin * 2, size - vergeMargin * 2);
  ctx.clip();

  traceRoadPath();
  ctx.strokeStyle = 'rgba(46, 72, 28, 0.48)';
  ctx.lineWidth = wRoad + Math.max(5, size * 0.034);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  traceRoadPath();
  ctx.strokeStyle = '#7c6d56';
  ctx.lineWidth = wRoad + Math.max(2.5, size * 0.018);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  // 2. Main PALETTE.ROAD fill
  traceRoadPath();
  ctx.strokeStyle = rgbStr(PALETTE.ROAD);
  ctx.lineWidth = wRoad;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (roadSides.length >= 3 || roadSides.length === 1) {
    ctx.fillStyle = rgbStr(PALETTE.ROAD);
    ctx.beginPath();
    ctx.arc(half, half, wRoad * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. Detailed cobblestone pavers & wheel tracks (clipped to >= 11px)
  const cobbleMargin = Math.max(11, Math.round(0.045 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(cobbleMargin, cobbleMargin, size - cobbleMargin * 2, size - cobbleMargin * 2);
  ctx.clip();

  traceRoadPath();
  ctx.strokeStyle = 'rgba(142, 126, 98, 0.35)';
  ctx.lineWidth = wRoad * 0.48;
  ctx.setLineDash([Math.max(2, size * 0.018), Math.max(2, size * 0.014)]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const s of roadSides) {
    for (const d of [0.12, 0.2, 0.28, 0.36, 0.44]) {
      for (const lat of [-0.038, 0.0, 0.038]) {
        const pt = edgePointCW(s, 0.5 + lat, d * size, size);
        ctx.fillStyle = lat === 0 ? 'rgba(182, 168, 138, 0.55)' : 'rgba(148, 134, 108, 0.48)';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size * 0.01, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * Draws interior special landmarks (`inset >= 16px`):
 * WATERFALL_BRIDGE, WATERFALL, BRIDGE_FLAT, BRIDGE_HILL, LAKE, SPRING, CLOISTER, CITY_GATE, junctions.
 */
function drawSpecials(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  levels: [number, number, number, number],
  size: number
): void {
  if (spec.special === 'NONE' || spec.special === 'CITY_SEPARATE') return;

  const safeInset = Math.max(16, Math.round(0.065 * size));
  const half = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(safeInset, safeInset, size - safeInset * 2, size - safeInset * 2);
  ctx.clip();

  // Helper to draw stone bridge parapets aligned with the ROAD axis
  const drawBridgeDeck = (withChevrons: boolean) => {
    const roadHorizontal = edges[1] === 'ROAD' || edges[3] === 'ROAD';
    const bLen = size * 0.34;
    const bHalfRoad = size * 0.095;
    const parapetT = size * 0.026;

    ctx.save();
    ctx.translate(half, half);
    if (!roadHorizontal) {
      ctx.rotate(Math.PI / 2);
    }

    // Bridge road deck
    ctx.fillStyle = rgbStr(PALETTE.ROAD);
    ctx.fillRect(-bLen / 2, -bHalfRoad, bLen, bHalfRoad * 2);

    // North/South stone parapets
    ctx.fillStyle = '#78716c';
    ctx.fillRect(-bLen / 2, -bHalfRoad - parapetT, bLen, parapetT);
    ctx.fillRect(-bLen / 2, bHalfRoad, bLen, parapetT);

    // Parapet capstones
    ctx.fillStyle = '#d6d3d1';
    for (const px of [-bLen * 0.42, 0, bLen * 0.42]) {
      ctx.fillRect(px - parapetT * 0.6, -bHalfRoad - parapetT * 1.1, parapetT * 1.2, parapetT * 1.2);
      ctx.fillRect(px - parapetT * 0.6, bHalfRoad - parapetT * 0.1, parapetT * 1.2, parapetT * 1.2);
    }

    if (withChevrons) {
      // Slope chevrons pointing toward the high road edge
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = Math.max(2, size * 0.01);
      for (const ox of [-size * 0.07, 0, size * 0.07]) {
        ctx.beginPath();
        ctx.moveTo(ox - size * 0.025, -size * 0.035);
        ctx.lineTo(ox + size * 0.02, 0);
        ctx.lineTo(ox - size * 0.025, size * 0.035);
        ctx.stroke();
      }
    }

    ctx.restore();
  };

  if (spec.special === 'WATERFALL_BRIDGE') {
    // Find the low (-1) water side
    let lowSide: DirIndex = 2;
    for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
      if (edges[s] === 'WATER' && levels[s] < 0) {
        lowSide = s;
      }
    }
    const poolPt = edgePointCW(lowSide, 0.5, size * 0.27, size);

    // Rocky cliff ledge across river
    ctx.fillStyle = '#57534e';
    ctx.beginPath();
    ctx.arc(poolPt.x, poolPt.y, size * 0.13, 0, Math.PI * 2);
    ctx.fill();

    // Plunge pool and white/cyan waterfall foam spray
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(poolPt.x, poolPt.y, size * 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e0f2fe';
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.arc(
        poolPt.x + (lowSide % 2 === 0 ? i * size * 0.025 : 0),
        poolPt.y + (lowSide % 2 === 1 ? i * size * 0.025 : 0),
        size * 0.028,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    // Arched stone bridge carrying the road across the center
    drawBridgeDeck(false);
  } else if (spec.special === 'WATERFALL') {
    let lowSide: DirIndex = 1;
    for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
      if (edges[s] === 'WATER' && levels[s] < 0) {
        lowSide = s;
      }
    }
    const dropPt = edgePointCW(lowSide, 0.5, size * 0.28, size);

    // Cliff rim
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = Math.max(4, size * 0.03);
    ctx.beginPath();
    ctx.arc(dropPt.x, dropPt.y, size * 0.12, 0, Math.PI * 2);
    ctx.stroke();

    // Plunge pool + foam band
    ctx.fillStyle = '#7dd3fc';
    ctx.beginPath();
    ctx.arc(dropPt.x, dropPt.y, size * 0.095, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f0f9ff';
    ctx.beginPath();
    ctx.arc(dropPt.x, dropPt.y, size * 0.055, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.special === 'BRIDGE_FLAT') {
    drawBridgeDeck(false);
  } else if (spec.special === 'BRIDGE_HILL') {
    drawBridgeDeck(true);
  } else if (spec.special === 'LAKE') {
    // Shoreline rim
    ctx.fillStyle = '#84a98c';
    ctx.beginPath();
    ctx.ellipse(half, half, size * 0.24, size * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Lake basin
    ctx.fillStyle = rgbStr(PALETTE.WATER);
    ctx.beginPath();
    ctx.ellipse(half, half, size * 0.22, size * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();

    // Shoreline ripples
    ctx.strokeStyle = '#bae6fd';
    ctx.lineWidth = Math.max(1.5, size * 0.008);
    ctx.beginPath();
    ctx.ellipse(half, half, size * 0.14, size * 0.11, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (spec.special === 'SPRING') {
    // Rocky spring boulders
    ctx.fillStyle = '#6b7280';
    for (let a = 0; a < 6; a++) {
      const ang = (a * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(
        half + Math.cos(ang) * size * 0.11,
        half + Math.sin(ang) * size * 0.11,
        size * 0.045,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.fillStyle = rgbStr(PALETTE.WATER);
    ctx.beginPath();
    ctx.arc(half, half, size * 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(half, half, size * 0.04, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.special === 'CLOISTER') {
    // Garden hedge around monastery
    const gSize = size * 0.34;
    ctx.fillStyle = '#3f6212';
    ctx.fillRect(half - gSize / 2, half - gSize / 2, gSize, gSize);

    // Stone cloister courtyard
    const cSize = size * 0.27;
    ctx.fillStyle = '#d6d3d1';
    ctx.fillRect(half - cSize / 2, half - cSize / 2, cSize, cSize);

    // Red-roofed monastery building
    const rSize = size * 0.19;
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(half - rSize / 2, half - rSize / 2, rSize, rSize);

    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(half - rSize / 2, half - rSize / 2);
    ctx.lineTo(half + rSize / 2, half - rSize / 2);
    ctx.lineTo(half, half);
    ctx.closePath();
    ctx.fill();

    // Golden spire cross at center
    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(half, half, size * 0.022, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.special === 'CITY_GATE') {
    // Find the CITY edge to place the gatehouse arch along its inner wall
    let citySide: DirIndex = 0;
    for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
      if (edges[s] === 'CITY') {
        citySide = s;
      }
    }
    const gatePt = edgePointCW(citySide, 0.5, size * 0.33, size);
    const tL = edgePointCW(citySide, 0.38, size * 0.33, size);
    const tR = edgePointCW(citySide, 0.62, size * 0.33, size);

    // Gatehouse flanking stone towers
    ctx.fillStyle = '#57534e';
    ctx.beginPath();
    ctx.arc(tL.x, tL.y, size * 0.048, 0, Math.PI * 2);
    ctx.arc(tR.x, tR.y, size * 0.048, 0, Math.PI * 2);
    ctx.fill();

    // Central arched gatehouse
    ctx.fillStyle = '#292524';
    ctx.beginPath();
    ctx.arc(gatePt.x, gatePt.y, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.special === 'ROAD_JUNCTION') {
    // Crossroads village well / signpost at center
    ctx.fillStyle = '#78716c';
    ctx.beginPath();
    ctx.arc(half, half, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(half, half, size * 0.022, 0, Math.PI * 2);
    ctx.fill();
  } else if (spec.special === 'RIVER_JUNCTION') {
    // Delta sandbar ripple at center
    ctx.strokeStyle = '#bae6fd';
    ctx.lineWidth = Math.max(1.5, size * 0.01);
    ctx.beginPath();
    ctx.arc(half, half, size * 0.055, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draws level indicator tabs strictly at `inset = 10..15px` (away from 2px/3px/4px socket probe points)
 * on edges where `rotatedEdgeLevels[s] !== 0`.
 */
function drawLevelCues(
  ctx: CanvasRenderingContext2D,
  levels: [number, number, number, number],
  size: number
): void {
  const scale = size / 256;
  const insetStart = Math.max(10, Math.round(10 * scale));
  const insetEnd = Math.max(insetStart + 3, Math.round(15 * scale));

  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    const lvl = levels[s];
    if (lvl === 0) continue;

    const p0 = edgePointCW(s, 0.44, insetStart, size);
    const p1 = edgePointCW(s, 0.56, insetStart, size);
    const p2 = edgePointCW(s, 0.56, insetEnd, size);
    const p3 = edgePointCW(s, 0.44, insetEnd, size);

    ctx.fillStyle = lvl > 0 ? '#f59e0b' : '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Stamps the outer 6px collar (`inset = 0..6px`) with pure canonical PALETTE colors
 * so that socket probes (`inset = 3px`, `inset = 4px`) and seam stitch probes (`inset = 2px`)
 * are 100% deterministic and stitch with zero color delta across adjacent tiles.
 */
function enforceEdgeSocketCollar(
  ctx: CanvasRenderingContext2D,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  size: number
): void {
  const collar = Math.max(6, Math.round((6 / 256) * size));

  const fillEdgeSpan = (side: DirIndex, uStart: number, uEnd: number, color: string) => {
    const p0 = edgePointCW(side, uStart, 0, size);
    const p1 = edgePointCW(side, uEnd, 0, size);
    const p2 = edgePointCW(side, uEnd, collar, size);
    const p3 = edgePointCW(side, uStart, collar, size);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();
  };

  // 1. Reset entire outer collar to pure PALETTE.GRASS
  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    fillEdgeSpan(s, 0.0, 1.0, rgbStr(PALETTE.GRASS));
  }

  // 2. Stamp each edge's canonical feature socket band
  for (let s = 0 as DirIndex; s < 4; s = (s + 1) as DirIndex) {
    const edgeType = edges[s];
    if (edgeType === 'CITY') {
      const prevSide = ((s + 3) % 4) as DirIndex;
      const nextSide = ((s + 1) % 4) as DirIndex;
      const u0 = edges[prevSide] === 'CITY' ? 0.0 : 0.06;
      const u1 = edges[nextSide] === 'CITY' ? 1.0 : 0.94;
      fillEdgeSpan(s, u0, u1, rgbStr(PALETTE.CITY));
    } else if (edgeType === 'WATER') {
      fillEdgeSpan(s, 0.4, 0.6, rgbStr(PALETTE.WATER));
    } else if (edgeType === 'ROAD') {
      fillEdgeSpan(s, 0.42, 0.58, rgbStr(PALETTE.ROAD));
    }
  }

  // 3. Enforce the 4 corner 8x8 zones: pure PALETTE.CITY if BOTH adjacent edges are CITY, else pure PALETTE.GRASS
  const cornerBox = Math.max(8, Math.round((8 / 256) * size));
  const corners: Array<{ x: number; y: number; adjA: DirIndex; adjB: DirIndex }> = [
    { x: 0, y: 0, adjA: 3, adjB: 0 }, // NW
    { x: size - cornerBox, y: 0, adjA: 0, adjB: 1 }, // NE
    { x: size - cornerBox, y: size - cornerBox, adjA: 1, adjB: 2 }, // SE
    { x: 0, y: size - cornerBox, adjA: 2, adjB: 3 }, // SW
  ];

  for (const c of corners) {
    const bothCity = edges[c.adjA] === 'CITY' && edges[c.adjB] === 'CITY';
    ctx.fillStyle = bothCity ? rgbStr(PALETTE.CITY) : rgbStr(PALETTE.GRASS);
    ctx.fillRect(c.x, c.y, cornerBox, cornerBox);
  }
}

/**
 * Draws realistic top-down tree canopy groves and roadside medieval cottages in open meadow quadrants
 * strictly inside `inset >= 16px` and clear of CITY/ROAD/WATER paths.
 */
function drawMeadowTreesAndHamlets(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  edges: [EdgeType, EdgeType, EdgeType, EdgeType],
  size: number
): void {
  const safeInset = Math.max(16, Math.round(0.065 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(safeInset, safeInset, size - safeInset * 2, size - safeInset * 2);
  ctx.clip();

  // 4 corner quadrants: NW (3,0), NE (0,1), SE (1,2), SW (2,3)
  const quadrants: Array<{ qx: number; qy: number; sideA: DirIndex; sideB: DirIndex; idx: number }> = [
    { qx: size * 0.2, qy: size * 0.2, sideA: 3, sideB: 0, idx: 0 },
    { qx: size * 0.8, qy: size * 0.2, sideA: 0, sideB: 1, idx: 1 },
    { qx: size * 0.8, qy: size * 0.8, sideA: 1, sideB: 2, idx: 2 },
    { qx: size * 0.2, qy: size * 0.8, sideA: 2, sideB: 3, idx: 3 },
  ];

  for (const q of quadrants) {
    if (edges[q.sideA] === 'CITY' || edges[q.sideB] === 'CITY') continue;

    // Draw a cluster of 2-3 lush tree canopies in open meadow corners (matching Design_of_game.jpeg)
    for (let t = 0; t < 3; t++) {
      const ox = (hash01(spec.id, q.idx * 10 + t * 2) - 0.5) * size * 0.12;
      const oy = (hash01(spec.id, q.idx * 10 + t * 2 + 1) - 0.5) * size * 0.12;
      const tx = q.qx + ox;
      const ty = q.qy + oy;
      const rad = size * (0.026 + (t % 2) * 0.01);

      // Canopy cast shadow
      ctx.fillStyle = 'rgba(24, 46, 16, 0.38)';
      ctx.beginPath();
      ctx.arc(tx + size * 0.009, ty + size * 0.009, rad * 1.05, 0, Math.PI * 2);
      ctx.fill();

      // Deep foliage base
      ctx.fillStyle = t % 2 === 0 ? '#2f5c22' : '#3d6e2a';
      ctx.beginPath();
      ctx.arc(tx, ty, rad, 0, Math.PI * 2);
      ctx.fill();

      // Sunlit foliage crown
      ctx.fillStyle = t % 2 === 0 ? '#5c943b' : '#74ad4a';
      ctx.beginPath();
      ctx.arc(tx - rad * 0.22, ty - rad * 0.22, rad * 0.68, 0, Math.PI * 2);
      ctx.fill();
    }

    // If adjacent to a ROAD and not WATER/LAKE/CLOISTER, add a tiny roadside cottage roof
    const hasRoad = edges[q.sideA] === 'ROAD' || edges[q.sideB] === 'ROAD';
    const hasWater = edges[q.sideA] === 'WATER' || edges[q.sideB] === 'WATER';
    if (hasRoad && !hasWater && spec.special !== 'CLOISTER' && q.idx % 2 === 1) {
      const hx = size * 0.5 + (q.qx - size * 0.5) * 0.52;
      const hy = size * 0.5 + (q.qy - size * 0.5) * 0.52;
      const cw = size * 0.068;
      const ch = size * 0.048;

      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(q.idx * 0.55);
      ctx.fillStyle = 'rgba(28, 18, 12, 0.35)';
      ctx.fillRect(-cw / 2 + size * 0.006, -ch / 2 + size * 0.006, cw, ch);
      ctx.fillStyle = '#cf5f36';
      ctx.fillRect(-cw / 2, -ch / 2, cw, ch * 0.52);
      ctx.fillStyle = '#993d1f';
      ctx.fillRect(-cw / 2, 0, cw, ch * 0.48);
      ctx.strokeStyle = '#3b2314';
      ctx.lineWidth = Math.max(1, size * 0.004);
      ctx.strokeRect(-cw / 2, -ch / 2, cw, ch);
      ctx.restore();
    }
  }

  ctx.restore();
}

/**
 * Procedurally paints a Carcassonne-3D (Tiers) tile onto a 2D canvas context.
 * Works identically in browser `HTMLCanvasElement` and Node `@napi-rs/canvas`.
 */
export function paintTile(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  rotation: Rotation = 0,
  size: number = 256
): void {
  const rotatedEdges = getRotatedEdges(spec, rotation);
  const rotatedLevels = getRotatedEdgeLevels(spec, rotation);

  // 1. Base fill with pure PALETTE.GRASS
  ctx.fillStyle = rgbStr(PALETTE.GRASS);
  ctx.fillRect(0, 0, size, size);

  // 2. Interior grass mowing stripes & hill/plateau terrace contours
  drawInteriorGrassAndContours(ctx, spec, rotation, rotatedLevels, size);

  // 3. Cities (edge bands, corner merges, interior stone walls, roofs, windows)
  drawCities(ctx, spec, rotatedEdges, size);

  // 4. Rivers (20% width centered on edge midpoint)
  drawRivers(ctx, rotatedEdges, size);

  // 5. Roads (16% width centered on edge midpoint, drawn after rivers so bridges cross over)
  drawRoads(ctx, rotatedEdges, size);

  // 6. Special interior landmarks (waterfalls, bridges, lake, spring, cloister, city gate)
  drawSpecials(ctx, spec, rotatedEdges, rotatedLevels, size);

  // 7. Meadow tree groves and roadside hamlet cottages
  drawMeadowTreesAndHamlets(ctx, spec, rotatedEdges, size);

  // 8. Level indicator tabs at inset 10..15px
  drawLevelCues(ctx, rotatedLevels, size);

  // 9. Enforce outer socket collar (inset 0..6px) for exact pixel probes & seam stitching
  enforceEdgeSocketCollar(ctx, rotatedEdges, size);
}

/**
 * Renders all 20 tiles in `DECK` across all 4 rotations (`0, 1, 2, 3`) into a single grid canvas.
 */
export function createTileSheet(
  canvasFactory?: (w: number, h: number) => any,
  tileSize = 96
): any {
  const makeCanvas =
    canvasFactory ??
    ((w: number, h: number) => {
      if (typeof document !== 'undefined') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      }
      throw new Error('canvasFactory is required in non-DOM environments');
    });

  const cols = 4;
  const rows = DECK.length;
  const pad = 8;
  const sheetW = cols * (tileSize + pad) + pad;
  const sheetH = rows * (tileSize + pad) + pad;

  const sheet = makeCanvas(sheetW, sheetH);
  const ctx = sheet.getContext('2d') as CanvasRenderingContext2D;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, sheetW, sheetH);

  const subCanvas = makeCanvas(tileSize, tileSize);
  const subCtx = subCanvas.getContext('2d') as CanvasRenderingContext2D;

  const rotations: Rotation[] = [0, 1, 2, 3];

  DECK.forEach((spec, rowIdx) => {
    rotations.forEach((rot, colIdx) => {
      paintTile(subCtx, spec, rot, tileSize);
      const x = pad + colIdx * (tileSize + pad);
      const y = pad + rowIdx * (tileSize + pad);
      ctx.drawImage(subCanvas as unknown as CanvasImageSource, x, y);
    });
  });

  return sheet;
}
