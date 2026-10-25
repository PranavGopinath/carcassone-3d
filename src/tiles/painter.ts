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
 * Draws the interior grass texture, mowing stripes, and hill/plateau contour terraces
 * strictly within `inset >= 10px` so outer edge sockets remain pure PALETTE colors.
 */
function drawInteriorGrassAndContours(
  ctx: CanvasRenderingContext2D,
  spec: TileSpec,
  rotation: Rotation,
  levels: [number, number, number, number],
  size: number
): void {
  const margin = Math.max(10, Math.round(0.04 * size));
  const half = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(margin, margin, size - margin * 2, size - margin * 2);
  ctx.clip();

  // Subtle mowing stripes rotated with the tile
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate((rotation * Math.PI) / 2);
  const stripeW = size * 0.08;
  for (let i = -8; i <= 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? 'rgba(118, 176, 84, 0.25)' : 'rgba(98, 156, 68, 0.22)';
    ctx.fillRect(i * stripeW, -half, stripeW * 0.55, size);
  }
  ctx.restore();

  // Subtle deterministic grass tuft flecks inside interior
  for (let i = 0; i < 18; i++) {
    const rx = (hash01(spec.id, i * 2) - 0.5) * (size - margin * 3);
    const ry = (hash01(spec.id, i * 2 + 1) - 0.5) * (size - margin * 3);
    const rotPt = rotateVec(rx, ry, rotation);
    const gx = half + rotPt.x;
    const gy = half + rotPt.y;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(88, 144, 58, 0.35)' : 'rgba(130, 188, 92, 0.35)';
    ctx.beginPath();
    ctx.arc(gx, gy, size * 0.012, 0, Math.PI * 2);
    ctx.fill();
  }

  // Elevation terrace contours for GRASS_HILL and GRASS_PLATEAU
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
              ? 'rgba(142, 198, 98, 0.48)'
              : step === 2
                ? 'rgba(126, 184, 86, 0.40)'
                : 'rgba(114, 172, 78, 0.32)';
          ctx.fill();
          ctx.lineWidth = Math.max(1.5, size * 0.009);
          ctx.strokeStyle = 'rgba(74, 124, 48, 0.55)';
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
          ? 'rgba(144, 200, 100, 0.42)'
          : step === 2
            ? 'rgba(128, 186, 88, 0.34)'
            : 'rgba(116, 174, 80, 0.28)';
      ctx.strokeStyle = 'rgba(74, 124, 48, 0.55)';
      ctx.lineWidth = Math.max(1.5, size * 0.008);
      ctx.beginPath();
      ctx.rect(insetStep, insetStep, w, w);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * Draws CITY segments, corner merges, interior stone walls, crenellations, roofs, and windows.
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

  const depth = 0.33 * size;
  const half = size / 2;

  // 1. Fill individual city edge bands
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
      // 3-edge stronghold covers center while leaving the 4th GRASS edge clear
      ctx.lineTo(half, half);
    }
    ctx.closePath();
    ctx.fill();
  }

  // 3. Draw interior fortified wall rims, crenellations, roof rows, and windows (strictly inset >= 10px)
  const interiorMargin = Math.max(10, Math.round(0.04 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(interiorMargin, interiorMargin, size - interiorMargin * 2, size - interiorMargin * 2);
  ctx.clip();

  for (const s of citySides) {
    const prevSide = ((s + 3) % 4) as DirIndex;
    const nextSide = ((s + 1) % 4) as DirIndex;
    const prevCity = edges[prevSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';
    const nextCity = edges[nextSide] === 'CITY' && spec.special !== 'CITY_SEPARATE';

    // Draw roof tiles and windows inside the city band (depth 0.10..0.24 * size)
    for (const u of [0.24, 0.42, 0.58, 0.76]) {
      const roofCenter = edgePointCW(s, u, size * 0.16, size);
      const rW = size * 0.09;
      const rH = size * 0.065;
      // Terracotta / slate roofs
      ctx.fillStyle = u === 0.42 ? '#64748b' : '#b86b43';
      ctx.fillRect(roofCenter.x - rW / 2, roofCenter.y - rH / 2, rW, rH);
      ctx.strokeStyle = '#5c3a21';
      ctx.lineWidth = Math.max(1, size * 0.005);
      ctx.strokeRect(roofCenter.x - rW / 2, roofCenter.y - rH / 2, rW, rH);

      // Tiny dark window
      ctx.fillStyle = '#292524';
      ctx.fillRect(roofCenter.x - size * 0.01, roofCenter.y - size * 0.01, size * 0.02, size * 0.02);
    }

    // Draw inner wall rim when not covered by 3-edge center merge
    if (citySides.length === 1 || spec.special === 'CITY_SEPARATE' || citySides.length === 2) {
      const pInnerStart = edgePointCW(s, prevCity ? 0.12 : 0.10, depth * 0.92, size);
      const pInnerMid = edgePointCW(s, 0.5, depth, size);
      const pInnerEnd = edgePointCW(s, nextCity ? 0.88 : 0.90, depth * 0.92, size);

      ctx.beginPath();
      ctx.moveTo(pInnerStart.x, pInnerStart.y);
      ctx.quadraticCurveTo(pInnerMid.x, pInnerMid.y, pInnerEnd.x, pInnerEnd.y);
      ctx.strokeStyle = '#6e5036';
      ctx.lineWidth = Math.max(3, size * 0.022);
      ctx.stroke();

      // Crenellation merlons along the wall
      for (const tu of [0.22, 0.36, 0.5, 0.64, 0.78]) {
        const mp = edgePointCW(s, tu, depth * 0.94, size);
        const mSize = size * 0.024;
        ctx.fillStyle = '#d6c7b2';
        ctx.fillRect(mp.x - mSize / 2, mp.y - mSize / 2, mSize, mSize);
      }
    }
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

  // 1. Interior river bank outline (clipped to interior >= bankMargin so edge sockets stay clean)
  ctx.save();
  ctx.beginPath();
  ctx.rect(bankMargin, bankMargin, size - bankMargin * 2, size - bankMargin * 2);
  ctx.clip();

  traceRiverPath();
  ctx.strokeStyle = '#3b6e52';
  ctx.lineWidth = wWater + Math.max(4, size * 0.028);
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

  // 3. Subtle interior water flow highlights (strictly clipped to interior >= 12px)
  const rippleMargin = Math.max(12, Math.round(0.05 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(rippleMargin, rippleMargin, size - rippleMargin * 2, size - rippleMargin * 2);
  ctx.clip();

  traceRiverPath();
  ctx.strokeStyle = 'rgba(135, 202, 248, 0.35)';
  ctx.lineWidth = wWater * 0.28;
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

  // 1. Interior road verge/curb (clipped to >= vergeMargin)
  ctx.save();
  ctx.beginPath();
  ctx.rect(vergeMargin, vergeMargin, size - vergeMargin * 2, size - vergeMargin * 2);
  ctx.clip();

  traceRoadPath();
  ctx.strokeStyle = '#8c7a5b';
  ctx.lineWidth = wRoad + Math.max(3, size * 0.02);
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
    ctx.arc(half, half, wRoad * 0.58, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. Subtle cobblestone center speckles (clipped to >= 12px)
  const cobbleMargin = Math.max(12, Math.round(0.05 * size));
  ctx.save();
  ctx.beginPath();
  ctx.rect(cobbleMargin, cobbleMargin, size - cobbleMargin * 2, size - cobbleMargin * 2);
  ctx.clip();

  for (const s of roadSides) {
    for (const d of [0.16, 0.28, 0.4]) {
      const pt = edgePointCW(s, 0.5, d * size, size);
      ctx.fillStyle = 'rgba(168, 148, 110, 0.45)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size * 0.012, 0, Math.PI * 2);
      ctx.fill();
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

  // 7. Level indicator tabs at inset 10..15px
  drawLevelCues(ctx, rotatedLevels, size);

  // 8. Enforce outer socket collar (inset 0..6px) for exact pixel probes & seam stitching
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
