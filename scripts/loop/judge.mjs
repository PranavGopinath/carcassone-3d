import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { callModel, uploadMediaFile } from '../lib/orchestrator.mjs';

export function formatTimestamp(seconds) {
  const totalSec = Math.max(0, Math.round(Number(seconds || 0)));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function loadRubric(workDir, config) {
  const rubricRel = config?.rubric || 'rubric/visual.json';
  const rubricPath = path.join(workDir, rubricRel);
  if (!fs.existsSync(rubricPath)) {
    throw new Error(`Missing rubric file at ${rubricPath}`);
  }
  return JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
}

export function loadJudgeSchema(workDir) {
  const candidates = [
    path.join(workDir, '.agents/skills/visual-feedback-loop/schemas/judge.schema.json'),
    path.join(workDir, 'schemas/judge.schema.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return {
    type: 'object',
    required: ['items', 'defects'],
    properties: {
      aestheticScore: { type: 'number' },
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'verdict', 'evidence'],
          properties: {
            id: { type: 'string' },
            verdict: { enum: ['pass', 'fail', 'uncertain'] },
            evidence: { type: 'string' },
            t: { type: 'string' },
            shot: { type: 'string' },
            markId: { type: 'integer' },
            view: { type: 'string' },
            gaps: {
              type: 'array',
              items: {
                type: 'object',
                required: ['rank', 'severity', 'description', 'region'],
                properties: {
                  rank: { type: 'integer' },
                  severity: { enum: ['high', 'medium', 'low'] },
                  description: { type: 'string' },
                  region: { type: 'string' },
                },
              },
            },
          },
        },
      },
      defects: {
        type: 'array',
        items: {
          type: 'object',
          required: ['itemIds', 'severity', 'description'],
          properties: {
            id: { type: 'string' },
            itemIds: { type: 'array', items: { type: 'string' } },
            severity: { enum: ['high', 'medium', 'low'] },
            t: { type: 'string' },
            shot: { type: 'string' },
            markId: { type: 'integer' },
            description: { type: 'string' },
            suspectedArea: { type: 'string' },
            view: { type: 'string' },
          },
        },
      },
    },
  };
}

/**
 * Validates that every reference image exists and every view in `config.views`
 * has at least one `defect` item and one `fidelity` item covering it.
 * Throws one error naming all gaps if any are missing (Startup check & Offline Test #1).
 */
export function validateRubricAndReferences(workDir, config, rubric) {
  const gaps = [];
  const allRefs = new Set(config.references || []);
  for (const item of rubric.items || []) {
    for (const ref of item.references || []) {
      allRefs.add(ref);
    }
  }

  for (const ref of allRefs) {
    const abs = path.resolve(workDir, ref);
    if (!fs.existsSync(abs)) {
      gaps.push(`missing reference file: ${ref}`);
    }
  }

  const views = config.views || ['2d', '3d'];
  for (const v of views) {
    const hasDefect = (rubric.items || []).some(
      (it) => !it.reportOnly && it.kind === 'defect' && Array.isArray(it.views) && it.views.includes(v)
    );
    const hasFidelity = (rubric.items || []).some(
      (it) => !it.reportOnly && it.kind === 'fidelity' && Array.isArray(it.views) && it.views.includes(v)
    );
    if (!hasDefect) {
      gaps.push(`view '${v}' has no defect item in rubric`);
    }
    if (!hasFidelity) {
      gaps.push(`view '${v}' has no fidelity item in rubric`);
    }
  }

  if (gaps.length > 0) {
    throw new Error(`Startup evaluation validation failed: ${gaps.join('; ')}`);
  }
}

/**
 * Checks whether an `audit:<field>` value passes Hard Rule 3:
 * "passes when the field is `true`, `0`, an empty array, or an object whose `ok` is `true`; anything else fails"
 */
export function isPassingAuditFieldValue(val) {
  if (val === true || val === 0) return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (val && typeof val === 'object' && !Array.isArray(val) && val.ok === true) return true;
  return false;
}

export function evaluateAuditField(field, auditObj, stepAudits = []) {
  if (!auditObj || !(field in auditObj) || auditObj[field] === undefined) {
    return {
      pass: false,
      missingField: true,
      evidence: `audit() does not return field '${field}'`,
      defectDescription: `Add '${field}' measurement to window.__game.audit() return object`,
    };
  }

  const val = auditObj[field];
  if (!isPassingAuditFieldValue(val)) {
    const details = Array.isArray(auditObj.details) ? auditObj.details.join('; ') : '';
    return {
      pass: false,
      missingField: false,
      evidence: `audit.${field} failed with value=${JSON.stringify(val)}${details ? ` (${details})` : ''}`,
      defectDescription: `Fix audit.${field} failure: value=${JSON.stringify(val)}${details ? ` (${details})` : ''}`,
    };
  }

  for (const sa of stepAudits || []) {
    if (!sa.audit || !(field in sa.audit) || sa.audit[field] === undefined) {
      return {
        pass: false,
        missingField: true,
        evidence: `audit() at step ${sa.stepIndex} (t=${sa.at}s) does not return field '${field}'`,
        defectDescription: `Ensure audit() always returns '${field}' across gameplay steps`,
      };
    }
    if (!isPassingAuditFieldValue(sa.audit[field])) {
      const details = Array.isArray(sa.audit.details) ? sa.audit.details.join('; ') : '';
      return {
        pass: false,
        missingField: false,
        evidence: `audit.${field} failed at step ${sa.stepIndex} (${sa.label}, t=${sa.at}s): value=${JSON.stringify(sa.audit[field])}${details ? ` (${details})` : ''}`,
        defectDescription: `Fix audit.${field} failure at gameplay step '${sa.label}' (t=${sa.at}s): ${JSON.stringify(sa.audit[field])}`,
      };
    }
  }

  return {
    pass: true,
    missingField: false,
    evidence: `audit.${field} passed (${JSON.stringify(val)})`,
  };
}

/**
 * Evaluates all hard sources (`frameDiff`, `blankFrame`, `stepErrors`, `audit:<field>`) for an item in a specific view.
 */
export function evaluateHardSourcesForItem(item, view, captureManifest) {
  const sources = item.source || [];
  const failures = [];
  const evidences = [];

  const isGameplayScript = Boolean(item.segment && captureManifest.gameplay?.[item.segment]);
  const scriptObj = isGameplayScript
    ? captureManifest.gameplay[item.segment]?.[view] ||
      Object.values(captureManifest.gameplay[item.segment] || {})[0]
    : null;

  for (const src of sources) {
    if (src === 'judge') continue;

    if (src === 'frameDiff') {
      const spikes = isGameplayScript
        ? scriptObj?.frameDiffSpikes || []
        : (captureManifest.timeline?.frameDiffSpikes || []).filter(
            (s) => !item.segment || s.segment === item.segment
          );
      if (spikes.length > 0) {
        const first = spikes[0];
        const ts = formatTimestamp(first.t);
        const msg = `frameDiff spike at ${ts} (t=${first.t}s, frame=${first.frameIndex}, cell=${first.cellIndex}, maxCell=${first.maxCellFrac}, d2=${first.d2}, reason=${first.reason})`;
        failures.push({
          source: 'frameDiff',
          t: ts,
          severity: 'high',
          description: msg,
        });
        evidences.push(msg);
      } else {
        evidences.push('frameDiff: 0 spikes');
      }
    } else if (src === 'blankFrame') {
      const blanks = isGameplayScript
        ? scriptObj?.blankFrames || []
        : (captureManifest.timeline?.blankFrames || []).filter((b) => {
            if (!item.segment) return true;
            const seg = (captureManifest.timeline?.segments || []).find((s) => s.id === item.segment);
            return seg ? b.t >= seg.start && b.t <= seg.end : true;
          });
      if (blanks.length > 0) {
        const first = blanks[0];
        const ts = formatTimestamp(first.t);
        const msg = `blankFrame detected at ${ts} (t=${first.t}s, frame=${first.frameIndex}, uniformRatio=${first.uniformRatio})`;
        failures.push({
          source: 'blankFrame',
          t: ts,
          severity: 'high',
          description: msg,
        });
        evidences.push(msg);
      } else {
        evidences.push('blankFrame: 0 blank frames');
      }
    } else if (src === 'stepErrors') {
      const errs = scriptObj?.stepErrors || [];
      if (errs.length > 0) {
        const summary = errs.map((e) => e.message).join('; ');
        const ts = formatTimestamp(errs[0].at || 0);
        failures.push({
          source: 'stepErrors',
          t: ts,
          severity: 'high',
          description: `stepErrors in '${item.segment}' (${view}): ${summary}`,
        });
        evidences.push(`stepErrors: ${summary}`);
      } else {
        evidences.push('stepErrors: 0 errors');
      }
    } else if (src.startsWith('audit:')) {
      const field = src.slice('audit:'.length);
      const stepAudits = isGameplayScript ? scriptObj?.stepAudits || [] : [];
      const res = evaluateAuditField(field, captureManifest.audit, stepAudits);
      if (!res.pass) {
        failures.push({
          source: src,
          severity: res.missingField ? 'high' : 'high',
          description: res.defectDescription,
        });
        evidences.push(res.evidence);
      } else {
        evidences.push(res.evidence);
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    evidence: evidences.join(' | '),
  };
}

/**
 * Draws numbered marks (`[{ shot, x, y, label }]`) onto an image and returns `{ path, base64 }`.
 */
export async function drawMarksOnImage(imagePath, marks, outPath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  if (!marks || marks.length === 0) {
    const buf = fs.readFileSync(imagePath);
    return { path: imagePath, base64: buf.toString('base64'), markedCount: 0 };
  }

  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  marks.forEach((m, idx) => {
    const num = idx + 1;
    const x = Math.max(14, Math.min(img.width - 14, Number(m.x || 0)));
    const y = Math.max(14, Math.min(img.height - 14, Number(m.y || 0)));

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220, 38, 38, 0.92)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), x, y);

    if (m.label) {
      const labelText = `${num}:${m.label}`;
      ctx.font = 'bold 11px sans-serif';
      const tw = ctx.measureText(labelText).width + 8;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.fillRect(x + 15, y - 9, tw, 18);
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.fillText(labelText, x + 19, y);
    }
    ctx.restore();
  });

  const buf = canvas.toBuffer('image/png');
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
  }
  return {
    path: outPath || imagePath,
    base64: buf.toString('base64'),
    markedCount: marks.length,
  };
}

/**
 * Produces a high-resolution crop of `imagePath` around `rect` (or marks or center focal region).
 */
export async function createImageCrop(imagePath, cropSpec, marks, outPath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  const img = await loadImage(imagePath);
  const w = img.width;
  const h = img.height;

  let cx = Math.floor(w * 0.22);
  let cy = Math.floor(h * 0.22);
  let cw = Math.floor(w * 0.56);
  let ch = Math.floor(h * 0.56);

  if (cropSpec && typeof cropSpec === 'object' && cropSpec.width && cropSpec.height) {
    cx = Math.max(0, Math.min(w - 10, Math.floor(cropSpec.x)));
    cy = Math.max(0, Math.min(h - 10, Math.floor(cropSpec.y)));
    cw = Math.max(16, Math.min(w - cx, Math.ceil(cropSpec.width)));
    ch = Math.max(16, Math.min(h - cy, Math.ceil(cropSpec.height)));
  } else if (Array.isArray(marks) && marks.length > 0) {
    const xs = marks.map((m) => Number(m.x || w / 2));
    const ys = marks.map((m) => Number(m.y || h / 2));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 120;
    cx = Math.max(0, Math.floor(minX - pad));
    cy = Math.max(0, Math.floor(minY - pad));
    cw = Math.min(w - cx, Math.max(240, Math.ceil(maxX - minX + pad * 2)));
    ch = Math.min(h - cy, Math.max(240, Math.ceil(maxY - minY + pad * 2)));
  }

  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  const buf = canvas.toBuffer('image/png');
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
  }
  return {
    path: outPath || imagePath,
    base64: buf.toString('base64'),
    rect: { x: cx, y: cy, width: cw, height: ch },
  };
}

/**
 * Creates a labelled horizontal filmstrip of frames around a `frameDiff` spike (§2 judge_a).
 */
export async function createSpikeFilmstrip(framePaths, spikeFrameIdx, fps, outPath) {
  if (!framePaths || framePaths.length === 0) return null;
  const indices = [];
  for (let d = -2; d <= 2; d++) {
    const idx = Math.max(0, Math.min(framePaths.length - 1, spikeFrameIdx + d));
    if (!indices.includes(idx)) indices.push(idx);
  }

  const loaded = [];
  for (const idx of indices) {
    if (fs.existsSync(framePaths[idx])) {
      loaded.push({ idx, img: await loadImage(framePaths[idx]) });
    }
  }
  if (loaded.length === 0) return null;

  const thumbW = 320;
  const thumbH = Math.round((loaded[0].img.height / loaded[0].img.width) * thumbW);
  const labelH = 28;
  const canvas = createCanvas(thumbW * loaded.length, thumbH + labelH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  loaded.forEach((entry, i) => {
    const x = i * thumbW;
    ctx.drawImage(entry.img, x, labelH, thumbW, thumbH);
    const tSec = (entry.idx / fps).toFixed(2);
    const mmss = formatTimestamp(entry.idx / fps);
    ctx.fillStyle = entry.idx === spikeFrameIdx ? '#ef4444' : '#e2e8f0';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(`f#${entry.idx} (${mmss} / ${tSec}s)`, x + 8, 19);
  });

  const buf = canvas.toBuffer('image/png');
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
  }
  return {
    path: outPath,
    base64: buf.toString('base64'),
  };
}

function readImageBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return null;
  return fs.readFileSync(imgPath).toString('base64');
}

function expandShotName(shotTemplate, view) {
  if (!shotTemplate) return shotTemplate;
  return String(shotTemplate).replace(/\{view\}/g, view || '3d');
}

/**
 * Merges raw judge verdicts and hard-check results, resolving disagreements or `uncertain`
 * verdicts via a tight-crop re-ask, and assigning canonical code defect IDs (`<judge>-<itemId>-<view>-<n>`)
 * per Hard Rule 8 and §2 Merging verdicts.
 */
export async function mergeAndResolveVerdicts({
  rubricItems,
  rawJudgeVerdicts,
  hardResultsByItemView,
  missingMarkDefects = [],
  reAskCallback = null,
  goldenAllowedDefectTypes = null,
}) {
  const itemResults = {};
  const openDefects = [];
  const reportOnlyDefects = [];
  const defectCounters = new Map();

  const nextDefectId = (prefix, itemId, view) => {
    const key = view ? `${prefix}-${itemId}-${view}` : `${prefix}-${itemId}`;
    const n = (defectCounters.get(key) || 0) + 1;
    defectCounters.set(key, n);
    return `${key}-${n}`;
  };

  for (const item of rubricItems) {
    const views = item.views || ['3d'];
    const isSingleCapture =
      Boolean(item.pairViews) ||
      item.segment === 'rise' ||
      item.segment === 'flat' ||
      item.segment === 'toggle';

    const evalViews = isSingleCapture ? [views.join('+')] : views;
    const perView = {};

    for (const vKey of evalViews) {
      const effectiveView = isSingleCapture ? views[0] : vKey;
      const hard = hardResultsByItemView?.[`${item.id}:${vKey}`] ||
        hardResultsByItemView?.[`${item.id}:${effectiveView}`] || {
          pass: true,
          failures: [],
          evidence: '',
        };

      // Collect all judge opinions for (item.id, vKey / effectiveView)
      const opinions = rawJudgeVerdicts.filter(
        (op) =>
          op.itemId === item.id &&
          (!op.view || op.view === vKey || op.view === effectiveView || isSingleCapture)
      );

      let judgeVerdict = 'pass';
      let judgeEvidence = '';
      let gaps = [];
      const needsJudge = (item.source || []).includes('judge');

      if (needsJudge) {
        if (opinions.length === 0) {
          judgeVerdict = 'uncertain';
          judgeEvidence = 'No judge verdict returned';
        } else {
          const verdicts = opinions.map((o) => o.verdict);
          const hasUncertain = verdicts.includes('uncertain');
          const hasDisagreement = verdicts.includes('pass') && verdicts.includes('fail');

          if (hasUncertain || hasDisagreement) {
            if (typeof reAskCallback === 'function') {
              const reAskRes = await reAskCallback(item, effectiveView, opinions);
              if (reAskRes && reAskRes.verdict) {
                opinions.push(reAskRes);
              }
            }
          }

          const finalVerdicts = opinions.map((o) => o.verdict);
          const passVotes = finalVerdicts.filter((v) => v === 'pass').length;
          const failVotes = finalVerdicts.filter((v) => v === 'fail').length;
          const uncertainVotes = finalVerdicts.filter((v) => v === 'uncertain').length;

          // An item still uncertain after the re-ask is a fail; never coerce uncertain to pass (§2)
          if (failVotes > passVotes || uncertainVotes > 0 || passVotes === 0) {
            judgeVerdict = 'fail';
          } else {
            judgeVerdict = 'pass';
          }

          judgeEvidence = opinions.map((o) => o.evidence).filter(Boolean).join(' | ');
          for (const op of opinions) {
            if (Array.isArray(op.gaps) && op.gaps.length > 0) {
              gaps = op.gaps;
            }
          }
        }

        // For fidelity items: pass ONLY when no high or medium gap remains (§2 Item kinds)
        if (item.kind === 'fidelity') {
          const hasHighOrMedium = gaps.some((g) => g.severity === 'high' || g.severity === 'medium');
          if (hasHighOrMedium) {
            judgeVerdict = 'fail';
          }
        }
      }

      // Measurements beat opinions (Hard rule 3)
      const finalPass = hard.pass && (!needsJudge || judgeVerdict === 'pass');
      const finalVerdict = finalPass ? 'pass' : 'fail';
      const combinedEvidence = [hard.evidence, judgeEvidence].filter(Boolean).join(' | ');

      if (isSingleCapture) {
        for (const declaredV of views) {
          perView[declaredV] = {
            verdict: finalVerdict,
            evidence: combinedEvidence,
            hardPass: hard.pass,
            judgeVerdict,
            ...(item.kind === 'fidelity' ? { gaps } : {}),
          };
        }
      } else {
        perView[vKey] = {
          verdict: finalVerdict,
          evidence: combinedEvidence,
          hardPass: hard.pass,
          judgeVerdict,
          ...(item.kind === 'fidelity' ? { gaps } : {}),
        };
      }

      // Create canonical defects for hard-check failures
      for (const hf of hard.failures || []) {
        const defObj = {
          id: nextDefectId('hard', item.id, isSingleCapture ? null : vKey),
          itemIds: [item.id],
          view: isSingleCapture ? views.join('+') : vKey,
          severity: hf.severity || 'high',
          t: hf.t || '00:00',
          shot: expandShotName(item.shot, effectiveView) || item.segment || '',
          description: hf.description,
          source: hf.source,
          reportOnly: Boolean(item.reportOnly),
        };
        if (item.reportOnly) {
          reportOnlyDefects.push(defObj);
        } else {
          openDefects.push(defObj);
        }
      }

      // Create canonical defects for fidelity gaps (every high/medium gap becomes a defect)
      if (item.kind === 'fidelity' && !finalPass) {
        const actionableGaps = gaps.filter((g) => g.severity === 'high' || g.severity === 'medium');
        const gapsToEmit =
          actionableGaps.length > 0
            ? actionableGaps
            : [
                {
                  rank: 1,
                  severity: 'high',
                  description: judgeEvidence || `Fidelity gap on ${item.id}: ${item.aspect}`,
                  region: 'whole board',
                },
              ];
        for (const g of gapsToEmit) {
          const defObj = {
            id: nextDefectId('fidelity', item.id, isSingleCapture ? null : vKey),
            itemIds: [item.id],
            view: isSingleCapture ? views.join('+') : vKey,
            severity: g.severity,
            shot: expandShotName(item.shot, effectiveView) || '',
            region: g.region,
            references: item.references || [],
            aspect: item.aspect,
            description: `[Fidelity ${item.id} - ${g.region}] ${g.description}`,
            reportOnly: Boolean(item.reportOnly),
          };
          if (item.reportOnly) {
            reportOnlyDefects.push(defObj);
          } else {
            openDefects.push(defObj);
          }
        }
      }

      // Create canonical defects for judge-reported defect failures (assigning code IDs, never model IDs!)
      if (item.kind === 'defect' && needsJudge && judgeVerdict === 'fail') {
        let emittedFromJudgeList = 0;
        for (const op of opinions) {
          const prefix = op.judgeRole === 'judge_a' ? 'motion' : 'still';
          for (const rawDef of op.defects || []) {
            if (Array.isArray(rawDef.itemIds) && !rawDef.itemIds.includes(item.id)) continue;
            if (
              goldenAllowedDefectTypes &&
              hard.pass &&
              rawDef.defectType &&
              !goldenAllowedDefectTypes.has(rawDef.defectType)
            ) {
              continue;
            }
            emittedFromJudgeList++;
            const defObj = {
              id: nextDefectId(prefix, item.id, isSingleCapture ? null : vKey),
              itemIds: [item.id],
              view: isSingleCapture ? views.join('+') : vKey,
              severity: rawDef.severity || 'high',
              t: rawDef.t || op.t || '00:00',
              shot: rawDef.shot || op.shot || expandShotName(item.shot, effectiveView) || item.segment || '',
              markId: rawDef.markId ?? op.markId,
              description: rawDef.description || op.evidence || item.text,
              suspectedArea: rawDef.suspectedArea,
              reportOnly: Boolean(item.reportOnly),
            };
            if (item.reportOnly) {
              reportOnlyDefects.push(defObj);
            } else {
              openDefects.push(defObj);
            }
          }
        }

        if (emittedFromJudgeList === 0 && hard.failures.length === 0) {
          const primaryOp = opinions[0] || {};
          const prefix = primaryOp.judgeRole === 'judge_a' ? 'motion' : 'still';
          const defObj = {
            id: nextDefectId(prefix, item.id, isSingleCapture ? null : vKey),
            itemIds: [item.id],
            view: isSingleCapture ? views.join('+') : vKey,
            severity: 'high',
            t: primaryOp.t || '00:00',
            shot: primaryOp.shot || expandShotName(item.shot, effectiveView) || item.segment || '',
            description: judgeEvidence || `Failed rubric item ${item.id}: ${item.text}`,
            reportOnly: Boolean(item.reportOnly),
          };
          if (item.reportOnly) {
            reportOnlyDefects.push(defObj);
          } else {
            openDefects.push(defObj);
          }
        }
      }
    }

    const overallPass = views.every((v) => perView[v]?.verdict === 'pass');
    itemResults[item.id] = {
      id: item.id,
      kind: item.kind,
      reportOnly: Boolean(item.reportOnly),
      views,
      verdict: overallPass ? 'pass' : 'fail',
      perView,
    };
  }

  for (const mDef of missingMarkDefects) {
    const id = nextDefectId('still', mDef.itemId, mDef.view);
    openDefects.push({
      id,
      itemIds: [mDef.itemId],
      view: mDef.view,
      severity: 'low',
      shot: mDef.shot,
      description: mDef.description,
      reportOnly: false,
    });
  }

  // Compute pass counts excluding reportOnly items (§2 Item kinds & Hard rule 11)
  const gradedItems = Object.values(itemResults).filter((r) => !r.reportOnly);
  const passedCount = gradedItems.filter((r) => r.verdict === 'pass').length;
  const totalCount = gradedItems.length;
  const defectItems = gradedItems.filter((r) => r.kind === 'defect');
  const fidelityItems = gradedItems.filter((r) => r.kind === 'fidelity');

  return {
    passedCount,
    totalCount,
    defectPassedCount: defectItems.filter((r) => r.verdict === 'pass').length,
    defectTotalCount: defectItems.length,
    fidelityPassedCount: fidelityItems.filter((r) => r.verdict === 'pass').length,
    fidelityTotalCount: fidelityItems.length,
    allPassed: passedCount === totalCount && openDefects.length === 0,
    items: itemResults,
    openDefects,
    forTheOwner: {
      items: Object.values(itemResults).filter((r) => r.reportOnly),
      defects: reportOnlyDefects,
    },
  };
}

/**
 * Runs both `judge_a` (motion) and `judge_b` (stills) on an iteration's capture manifest (§2).
 */
export async function judgeIteration(workDir, iterDir, captureManifest, config, options = {}) {
  const rubric = options.rubric || loadRubric(workDir, config);
  const schema = loadJudgeSchema(workDir);
  const modelName = config.model?.name || 'gemini-4-argon';
  const outOfScopeList = config.outOfScope || [];
  const hideHardChecks = Boolean(options.hideHardChecks);

  const hardResultsByItemView = {};
  const rawJudgeVerdicts = [];
  const missingMarkDefects = [];
  const interactionIds = [];

  // 1. Evaluate hard sources for every item and view
  for (const item of rubric.items || []) {
    const views = item.views || ['3d'];
    const isSingleCapture =
      Boolean(item.pairViews) ||
      item.segment === 'rise' ||
      item.segment === 'flat' ||
      item.segment === 'toggle';
    const evalViews = isSingleCapture ? [views.join('+')] : views;

    for (const vKey of evalViews) {
      const effectiveView = isSingleCapture ? views[0] : vKey;
      hardResultsByItemView[`${item.id}:${vKey}`] = hideHardChecks
        ? { pass: true, failures: [], evidence: '' }
        : evaluateHardSourcesForItem(item, effectiveView, captureManifest);
    }
  }

  // 2. Motion Judge (`judge_a`): cinematic motionSegments + gameplay videos
  const motionItems = (rubric.items || []).filter(
    (it) =>
      (it.source || []).includes('judge') &&
      it.segment &&
      it.at !== 'after-step' &&
      !it.pairViews &&
      it.segment !== 'flat'
  );

  // 2a. Cinematic motionSegments (e.g. "rise")
  for (const segId of config.timeline?.motionSegments || []) {
    const segItems = motionItems.filter((it) => it.segment === segId);
    if (segItems.length === 0) continue;

    const clipInfo = captureManifest.motionSegmentClips?.[segId];
    const videoPath = clipInfo?.path || captureManifest.flightWebmPath;
    const inputParts = [];

    if (videoPath && fs.existsSync(videoPath)) {
      const uploaded = await uploadMediaFile(videoPath, 'video/webm');
      inputParts.push({
        type: 'video',
        uri: uploaded.uri,
        mime_type: 'video/webm',
        media_resolution: 'high',
        resolution: 'high',
        fps: config.timeline?.fps || 12,
        start_offset: `${clipInfo?.start ?? 3}s`,
        end_offset: `${clipInfo?.end ?? 5}s`,
      });
    }

    const segSpikes = (captureManifest.timeline?.frameDiffSpikes || []).filter((s) => s.segment === segId);
    for (let sIdx = 0; sIdx < segSpikes.length; sIdx++) {
      const sp = segSpikes[sIdx];
      const stripPath = path.join(iterDir, 'crops', `spike-${segId}-${sp.frameIndex}.png`);
      const strip = await createSpikeFilmstrip(
        captureManifest.timeline?.framePaths || [],
        sp.frameIndex,
        config.timeline?.fps || 12,
        stripPath
      );
      if (strip) {
        inputParts.push({
          type: 'text',
          text: `[Image ${sIdx + 1}: filmstrip around frameDiff spike at ${formatTimestamp(sp.t)} in segment '${segId}']`,
        });
        inputParts.push({
          type: 'image',
          data: strip.base64,
          mime_type: 'image/png',
          media_resolution: 'high',
          resolution: 'high',
        });
      }
    }

    inputParts.push({
      type: 'text',
      text: [
        `Motion clip: cinematic segment '${segId}' (${formatTimestamp(clipInfo?.start ?? 3)} to ${formatTimestamp(clipInfo?.end ?? 5)}).`,
        `Out of scope (ignore when grading non-reportOnly items): ${outOfScopeList.join('; ')}`,
        `Grade only the following motion rubric items and return JSON matching JudgeVerdict schema (timestamps as MM:SS):`,
        ...segItems.map((it) => `- ${it.id} (views: ${it.views.join(',')}): ${it.text}`),
      ].join('\n'),
    });

    const callRes = await callModel({
      role: 'judge_a',
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: inputParts,
      taskId: `judge_a:${segId}`,
      schema,
      rootDir: workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeJudgeHandler,
    });
    interactionIds.push(callRes.interactionId);
    collectJudgeOutput(callRes.output, 'judge_a', null, segItems, rawJudgeVerdicts);
  }

  // 2b. Gameplay motion clips (`play-<scriptId>-<view>.webm`)
  for (const script of config.gameplay?.scripts || []) {
    const sItems = motionItems.filter((it) => it.segment === script.id);
    if (sItems.length === 0) continue;

    const viewsToJudge = script.perView ? config.gameplay?.views || ['2d', '3d'] : [script.startView || '2d'];
    for (const v of viewsToJudge) {
      const cap = captureManifest.gameplay?.[script.id]?.[v];
      if (!cap) continue;

      const inputParts = [];
      if (cap.videoPath && fs.existsSync(cap.videoPath)) {
        const uploaded = await uploadMediaFile(cap.videoPath, 'video/webm');
        inputParts.push({
          type: 'video',
          uri: uploaded.uri,
          mime_type: 'video/webm',
          media_resolution: 'high',
          resolution: 'high',
          fps: config.gameplay?.fps || 12,
        });
      }

      const spikes = cap.frameDiffSpikes || [];
      for (let sIdx = 0; sIdx < Math.min(3, spikes.length); sIdx++) {
        const sp = spikes[sIdx];
        const stripPath = path.join(iterDir, 'crops', `spike-${script.id}-${v}-${sp.frameIndex}.png`);
        const strip = await createSpikeFilmstrip(
          cap.framePaths || [],
          sp.frameIndex,
          config.gameplay?.fps || 12,
          stripPath
        );
        if (strip) {
          inputParts.push({
            type: 'text',
            text: `[Image ${sIdx + 1}: filmstrip around frameDiff spike at ${formatTimestamp(sp.t)} in '${script.id}' (${v})]`,
          });
          inputParts.push({
            type: 'image',
            data: strip.base64,
            mime_type: 'image/png',
            media_resolution: 'high',
            resolution: 'high',
          });
        }
      }

      const stepLabels = (script.steps || [])
        .map((st) => `${formatTimestamp(st.at)} ${st.label || st.call || st.click}`)
        .join('\n');

      inputParts.push({
        type: 'text',
        text: [
          `Gameplay motion clip: script '${script.id}' in view '${v}'.`,
          `Expected step timeline (MM:SS):`,
          stepLabels,
          `Out of scope (ignore when grading non-reportOnly items): ${outOfScopeList.join('; ')}`,
          `Grade only the following motion rubric items for view '${v}' and return JSON matching JudgeVerdict schema:`,
          ...sItems.map((it) => `- ${it.id} (view: ${v}): ${it.text}`),
        ].join('\n'),
      });

      const callRes = await callModel({
        role: 'judge_a',
        model: modelName,
        thinking: 'high',
        mediaResolution: 'high',
        media_resolution: 'high',
        input: inputParts,
        taskId: `judge_a:${script.id}:${v}`,
        schema,
        rootDir: workDir,
        tracePath: options.tracePath,
        state: options.state,
        budgetUsd: options.budgetUsd,
        fakeHandler: options.fakeJudgeHandler,
      });
      interactionIds.push(callRes.interactionId);
      collectJudgeOutput(callRes.output, 'judge_a', script.perView ? v : null, sItems, rawJudgeVerdicts);
    }
  }

  // 3. Stills Judge (`judge_b`): one call per shot group and view (§2 Judges)
  const stillItems = (rubric.items || []).filter(
    (it) =>
      (it.source || []).includes('judge') &&
      (it.shot || it.shots || it.at === 'after-step' || it.pairViews || it.segment === 'flat')
  );

  const shotGroups = new Map();
  for (const item of stillItems) {
    const views = item.views || ['3d'];
    const isSingleCapture = Boolean(item.pairViews) || item.segment === 'flat';
    const evalViews = isSingleCapture ? [views[0]] : views;

    for (const v of evalViews) {
      let groupKey;
      if (item.pairViews) {
        groupKey = `pairViews:${item.id}:${v}`;
      } else if (item.at === 'after-step' && item.segment) {
        groupKey = `after-step:${item.segment}:${v}`;
      } else {
        const shotList = item.shots
          ? item.shots.map((s) => expandShotName(s, v))
          : [expandShotName(item.shot || (item.segment === 'flat' ? 'board-2d' : 'terrace-overview'), v)];
        groupKey = `shots:${item.kind}:${shotList.join('+')}:${v}`;
      }
      if (!shotGroups.has(groupKey)) {
        shotGroups.set(groupKey, { groupKey, view: v, isSingleCapture, items: [] });
      }
      shotGroups.get(groupKey).items.push(item);
    }
  }

  const groupList = Array.from(shotGroups.values());
  const runGroup = async (group) => {
    const { view: v, isSingleCapture, items: groupItems } = group;
    const inputParts = [];
    let imgCounter = 0;
    const addedLabels = new Set();

    const addLabelledImage = (label, base64) => {
      if (!base64 || addedLabels.has(label)) return;
      addedLabels.add(label);
      imgCounter += 1;
      inputParts.push({ type: 'text', text: `[Image ${imgCounter}: ${label}]` });
      inputParts.push({
        type: 'image',
        data: base64,
        mime_type: 'image/png',
        media_resolution: 'high',
        resolution: 'high',
      });
    };

    for (const item of groupItems) {
      const marksName = item.marks;
      const allMarksForName = marksName ? captureManifest.audit?.marks?.[marksName] : null;
      if (marksName && !Array.isArray(allMarksForName) && !hideHardChecks) {
        missingMarkDefects.push({
          itemId: item.id,
          view: v,
          shot: expandShotName(item.shot, v) || (item.shots ? item.shots.join(',') : item.segment || ''),
          description: `Expose audit().marks.${marksName} ([{ shot, x, y, label }]) so numbered marks can be drawn for rubric item ${item.id}`,
        });
      }

      if (item.pairViews) {
        if (item.shots && item.shots.length >= 2) {
          for (const sName of item.shots) {
            const rawPath = captureManifest.shotPaths?.[sName];
            const shotMarks = Array.isArray(allMarksForName)
              ? allMarksForName.filter((m) => !m.shot || m.shot === sName)
              : [];
            const markedOutPath = path.join(iterDir, 'crops', `marked-${item.id}-${sName}.png`);
            const marked = await drawMarksOnImage(rawPath, shotMarks, markedOutPath);
            addLabelledImage(`${sName}, full shot with shared tile marks`, marked?.base64);
          }
        } else if (item.segment && item.at === 'after-step') {
          const cap2d = captureManifest.gameplay?.[item.segment]?.['2d'];
          const cap3d = captureManifest.gameplay?.[item.segment]?.['3d'];
          const stepsLen = Math.max(cap2d?.stepFrames?.length || 0, cap3d?.stepFrames?.length || 0);
          for (let sIdx = 0; sIdx < stepsLen; sIdx++) {
            const f2d = cap2d?.stepFrames?.[sIdx];
            const f3d = cap3d?.stepFrames?.[sIdx];
            const stepMarks2d = Array.isArray(allMarksForName)
              ? allMarksForName.filter((m) => !m.shot || m.shot === 'board-2d' || m.shot === '2d')
              : [];
            const stepMarks3d = Array.isArray(allMarksForName)
              ? allMarksForName.filter((m) => !m.shot || m.shot === 'terrace-overview' || m.shot === '3d')
              : [];
            if (f2d?.path) {
              const m2 = await drawMarksOnImage(
                f2d.path,
                stepMarks2d,
                path.join(iterDir, 'crops', `marked-${item.id}-2d-step-${sIdx}.png`)
              );
              addLabelledImage(
                `${item.segment} 2D after step ${sIdx + 1} (${formatTimestamp(f2d.at)} ${f2d.label})`,
                m2?.base64
              );
            }
            if (f3d?.path) {
              const m3 = await drawMarksOnImage(
                f3d.path,
                stepMarks3d,
                path.join(iterDir, 'crops', `marked-${item.id}-3d-step-${sIdx}.png`)
              );
              addLabelledImage(
                `${item.segment} 3D after step ${sIdx + 1} (${formatTimestamp(f3d.at)} ${f3d.label})`,
                m3?.base64
              );
            }
          }
        }
      } else if (item.at === 'after-step' && item.segment) {
        const cap = captureManifest.gameplay?.[item.segment]?.[v];
        for (const sf of cap?.stepFrames || []) {
          addLabelledImage(
            `${item.segment} (${v}) settled after step ${sf.stepIndex + 1}: ${formatTimestamp(sf.at)} ${sf.label}`,
            readImageBase64(sf.path)
          );
          if (item.crop === true) {
            const crop = await createImageCrop(
              sf.path,
              null,
              allMarksForName,
              path.join(iterDir, 'crops', `crop-${item.id}-${v}-step-${sf.stepIndex}.png`)
            );
            addLabelledImage(
              `${item.segment} (${v}) step ${sf.stepIndex + 1}, high-resolution crop`,
              crop?.base64
            );
          }
        }
      } else {
        const shotList = item.shots
          ? item.shots.map((s) => expandShotName(s, v))
          : [expandShotName(item.shot || (item.segment === 'flat' ? 'board-2d' : 'terrace-overview'), v)];

        for (const sName of shotList) {
          const rawPath = captureManifest.shotPaths?.[sName];
          const shotMarks = Array.isArray(allMarksForName)
            ? allMarksForName.filter((m) => !m.shot || m.shot === sName)
            : [];
          const marked = await drawMarksOnImage(
            rawPath,
            shotMarks,
            path.join(iterDir, 'crops', `marked-${item.id}-${v}-${sName}.png`)
          );
          addLabelledImage(
            shotMarks.length > 0 ? `${sName}, full shot (marked for ${item.id})` : `${sName}, full shot`,
            marked?.base64
          );

          if (item.crop && sName !== 'tileSheet') {
            const selRect =
              typeof item.crop === 'string'
                ? captureManifest.audit?.selectorRectsByShot?.[sName]?.[item.crop]
                : null;
            const crop = await createImageCrop(
              rawPath,
              selRect,
              shotMarks,
              path.join(iterDir, 'crops', `crop-${item.id}-${v}-${sName}.png`)
            );
            addLabelledImage(
              `${sName}, high-resolution crop for ${item.id}${typeof item.crop === 'string' ? ` (${item.crop})` : ''}`,
              crop?.base64
            );
          }
        }
      }
    }

    // Attach unique reference images after shot images
    for (const item of groupItems) {
      for (const refRel of item.references || []) {
        const refAbs = path.resolve(workDir, refRel);
        const refBase = path.basename(refRel, path.extname(refRel));
        addLabelledImage(`reference ${refBase}`, readImageBase64(refAbs));
      }
    }

    // Put all grading instructions AFTER the media (§2 Prompt layout)
    const instructionLines = [
      `Evaluate the following ${groupItems.length} rubric item(s) for view '${v}' and return an entry in 'items' for EACH item ID (${groupItems.map((i) => i.id).join(', ')}):`,
      `Out of scope (ignore when grading non-reportOnly items): ${outOfScopeList.join('; ')}`,
    ];

    for (const item of groupItems) {
      if (item.kind === 'fidelity') {
        instructionLines.push(
          `\n- Item ${item.id} [FIDELITY, view=${v}]:`,
          `  Aspect: ${item.aspect}`,
          `  Requirement: ${item.text}`,
          `  Note: The reference image shows style, materials, lighting and density, NOT layout: ignore differences in board shape, tile arrangement and terrain elevation that come from the game's rules.`,
          `  Return a ranked list of concrete, visible differences (gaps) between the render and the reference for this aspect, each with rank (1..N), severity ('high'|'medium'|'low'), description, and region. Verdict passes ONLY when no 'high' or 'medium' gap remains.`
        );
      } else if (item.pairViews) {
        instructionLines.push(
          `\n- Item ${item.id} [CROSS-VIEW CONSISTENCY, views=2d,3d]:`,
          `  Requirement: ${item.text}`,
          `  The tile specification and game state are the source of truth. Compare matching numbered tile marks across the 2D and 3D images. List every object or feature present in one view and missing, moved or different in the other; for each mismatch emit a defect naming the tile mark, both views ('2d' and '3d'), and which view departs from the tile spec.`
        );
      } else {
        instructionLines.push(
          `\n- Item ${item.id} [DEFECT, view=${v}${item.reportOnly ? ', reportOnly=true' : ''}]:`,
          `  Requirement: ${item.text}`,
          `  If failing, cite the shot or timestamp (MM:SS) plus the markId or image region.`
        );
      }
    }

    inputParts.push({
      type: 'text',
      text: instructionLines.join('\n'),
    });

    const callRes = await callModel({
      role: 'judge_b',
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: inputParts,
      taskId: `judge_b:${groupItems.map((i) => i.id).join('_')}:${v}`,
      schema,
      rootDir: workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeJudgeHandler,
    });
    interactionIds.push(callRes.interactionId);
    collectJudgeOutput(callRes.output, 'judge_b', isSingleCapture ? null : v, groupItems, rawJudgeVerdicts);
  };

  const concurrency = 4;
  for (let i = 0; i < groupList.length; i += concurrency) {
    await Promise.all(groupList.slice(i, i + concurrency).map(runGroup));
  }

  // Tight-crop re-ask callback when judges disagree or say `uncertain` (§2 Merging verdicts)
  const reAskCallback = async (item, view, prevOpinions) => {
    const shotName = expandShotName(item.shot || (item.shots ? item.shots[0] : 'terrace-overview'), view);
    const rawPath = captureManifest.shotPaths?.[shotName];
    const reAskParts = [];
    if (rawPath && fs.existsSync(rawPath)) {
      const tightCrop = await createImageCrop(
        rawPath,
        null,
        null,
        path.join(iterDir, 'crops', `reask-${item.id}-${view}.png`)
      );
      if (tightCrop) {
        reAskParts.push({ type: 'text', text: `[Image 1: ${shotName}, tighter high-resolution crop]` });
        reAskParts.push({
          type: 'image',
          data: tightCrop.base64,
          mime_type: 'image/png',
          media_resolution: 'high',
          resolution: 'high',
        });
      }
    }
    reAskParts.push({
      type: 'text',
      text: `Re-evaluating item ${item.id} (${view}) on a tighter crop due to previous uncertainty/disagreement (${prevOpinions.map((o) => o.verdict).join(', ')}). Requirement: ${item.text}. Provide a definitive pass or fail verdict.`,
    });

    const reRes = await callModel({
      role: 'judge_b',
      model: modelName,
      thinking: 'high',
      mediaResolution: 'high',
      media_resolution: 'high',
      input: reAskParts,
      taskId: `judge_b:reask:${item.id}:${view}`,
      schema,
      rootDir: workDir,
      tracePath: options.tracePath,
      state: options.state,
      budgetUsd: options.budgetUsd,
      fakeHandler: options.fakeReAskHandler || options.fakeJudgeHandler,
    });
    interactionIds.push(reRes.interactionId);
    const reItems = reRes.output?.items || [];
    const found = reItems.find((i) => i.id === item.id) || reItems[0];
    return {
      judgeRole: 'judge_b',
      itemId: item.id,
      view,
      verdict: found?.verdict || 'uncertain',
      evidence: found?.evidence || 'Re-ask verdict',
      gaps: found?.gaps || [],
      defects: reRes.output?.defects || [],
    };
  };

  const merged = await mergeAndResolveVerdicts({
    rubricItems: rubric.items || [],
    rawJudgeVerdicts,
    hardResultsByItemView,
    missingMarkDefects,
    reAskCallback,
    goldenAllowedDefectTypes: options.goldenAllowedDefectTypes || null,
  });

  const fullReport = {
    ...merged,
    interactionIds,
  };

  if (iterDir) {
    fs.mkdirSync(iterDir, { recursive: true });
    fs.writeFileSync(path.join(iterDir, 'verdicts.json'), JSON.stringify(fullReport, null, 2), 'utf8');
  }

  return fullReport;
}

function collectJudgeOutput(output, judgeRole, forcedView, targetItems, rawJudgeVerdicts) {
  const outItems = Array.isArray(output?.items) ? output.items : [];
  const outDefects = Array.isArray(output?.defects) ? output.defects : [];

  for (const item of targetItems) {
    const matched = outItems.find((i) => i.id === item.id);
    const itemDefects = outDefects.filter(
      (d) => Array.isArray(d.itemIds) && d.itemIds.includes(item.id)
    );
    rawJudgeVerdicts.push({
      judgeRole,
      itemId: item.id,
      view: forcedView || matched?.view || null,
      verdict: matched?.verdict || 'pass',
      evidence: matched?.evidence || output?.summary || '',
      t: matched?.t,
      shot: matched?.shot,
      markId: matched?.markId,
      gaps: matched?.gaps || [],
      defects: itemDefects,
    });
  }
}

/**
 * Pairwise comparison between `bestCapture` and `currentCapture` (§2 Pairwise & Hard Rule 11).
 * Runs on every shot touched by this iteration's defects plus every fidelity shot, in every view they apply to.
 * Asks in both orders (A=best/B=current and A=current/B=best) and counts a winner only if it wins both times.
 * Also checks whether anything in `config.outOfScope` changed in both orders.
 */
export async function runPairwiseComparison({
  workDir,
  bestCapture,
  currentCapture,
  rubric,
  touchedDefectIds = [],
  currentVerdicts,
  config,
  options = {},
}) {
  const modelName = config.model?.name || 'gemini-4-argon';
  const outOfScopeList = config.outOfScope || [];
  const pairwiseSchema = {
    type: 'object',
    required: ['winner', 'reason', 'outOfScopeChanged'],
    properties: {
      winner: { enum: ['A', 'B', 'tie'] },
      reason: { type: 'string' },
      outOfScopeChanged: { type: 'boolean' },
    },
  };

  // Determine items to compare: every fidelity item + every defect item touched this iteration
  const touchedItemIds = new Set();
  for (const d of currentVerdicts?.openDefects || []) {
    for (const id of d.itemIds || []) touchedItemIds.add(id);
  }
  for (const id of touchedDefectIds) {
    touchedItemIds.add(id);
  }

  const itemsToCompare = (rubric.items || []).filter(
    (it) => !it.reportOnly && (it.kind === 'fidelity' || touchedItemIds.has(it.id))
  );

  let currentWins = 0;
  let bestWins = 0;
  let ties = 0;
  let confirmedOutOfScopeChange = false;
  const comparisons = [];

  const pairwiseTasks = [];
  for (const item of itemsToCompare) {
    const views = item.views || ['3d'];
    for (const v of views) {
      pairwiseTasks.push({ item, v });
    }
  }

  const runPairwiseTask = async ({ item, v }) => {
    const shotName = expandShotName(
      item.shot || (item.shots ? item.shots[0] : 'terrace-overview'),
      v
    );
    const bestShotPath = bestCapture?.shotPaths?.[shotName];
    const currShotPath = currentCapture?.shotPaths?.[shotName];
    const bestB64 = readImageBase64(bestShotPath);
    const currB64 = readImageBase64(currShotPath);
    if (!bestB64 || !currB64) return;

    const askOneOrder = async (labelOrder, imgABase64, imgBBase64) => {
      const parts = [];
      let idx = 0;
      if (item.kind === 'fidelity') {
        for (const refRel of item.references || []) {
          const refB64 = readImageBase64(path.resolve(workDir, refRel));
          if (refB64) {
            idx++;
            parts.push({ type: 'text', text: `[Image ${idx}: reference ${path.basename(refRel)}]` });
            parts.push({
              type: 'image',
              data: refB64,
              mime_type: 'image/png',
              media_resolution: 'high',
              resolution: 'high',
            });
          }
        }
      }
      idx++;
      parts.push({ type: 'text', text: `[Image ${idx}: Render A (${shotName}, view ${v})]` });
      parts.push({
        type: 'image',
        data: imgABase64,
        mime_type: 'image/png',
        media_resolution: 'high',
        resolution: 'high',
      });
      idx++;
      parts.push({ type: 'text', text: `[Image ${idx}: Render B (${shotName}, view ${v})]` });
      parts.push({
        type: 'image',
        data: imgBBase64,
        mime_type: 'image/png',
        media_resolution: 'high',
        resolution: 'high',
      });

      const question =
        item.kind === 'fidelity'
          ? `Compare Render A and Render B against the reference for aspect (${item.id}): "${item.aspect}". Which render is closer to the reference for this specific aspect?`
          : `Compare Render A and Render B for defect item (${item.id}): "${item.text}". Which render shows less of this defect?`;

      parts.push({
        type: 'text',
        text: [
          question,
          `Also check whether anything out of scope changed between Render A and Render B. Out of scope: ${outOfScopeList.join('; ')}`,
          `Return JSON with winner ('A'|'B'|'tie'), reason, and outOfScopeChanged (boolean).`,
        ].join('\n'),
      });

      const res = await callModel({
        role: 'judge_b',
        model: modelName,
        thinking: 'high',
        mediaResolution: 'high',
        media_resolution: 'high',
        input: parts,
        taskId: `pairwise:${item.id}:${v}:${labelOrder}`,
        schema: pairwiseSchema,
        rootDir: workDir,
        tracePath: options.tracePath,
        state: options.state,
        budgetUsd: options.budgetUsd,
        fakeHandler: options.fakePairwiseHandler,
      });
      return res.output || { winner: 'tie', reason: '', outOfScopeChanged: false };
    };

    const [order1, order2] = await Promise.all([
      askOneOrder('order1', bestB64, currB64),
      askOneOrder('order2', currB64, bestB64),
    ]);

    if (order1.outOfScopeChanged === true && order2.outOfScopeChanged === true) {
      confirmedOutOfScopeChange = true;
    }

    let itemWinner = 'tie';
    if (order1.winner === 'B' && order2.winner === 'A') {
      itemWinner = 'current';
      currentWins += 1;
    } else if (order1.winner === 'A' && order2.winner === 'B') {
      itemWinner = 'best';
      bestWins += 1;
    } else {
      ties += 1;
    }

    comparisons.push({
      itemId: item.id,
      view: v,
      shot: shotName,
      winner: itemWinner,
      order1,
      order2,
    });
  };

  for (let i = 0; i < pairwiseTasks.length; i += 4) {
    await Promise.all(pairwiseTasks.slice(i, i + 4).map(runPairwiseTask));
  }

  return {
    currentWins,
    bestWins,
    ties,
    confirmedOutOfScopeChange,
    comparisons,
  };
}
