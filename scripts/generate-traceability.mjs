// Generates docs/traceability.md from SRS.md so requirement coverage is derived, not hand-typed.
// Fails (exit 1) if any FR/NFR/SEC id found in the SRS has no phase mapping, or a mapping refers to an id that no longer exists.
import { readFileSync, writeFileSync } from 'node:fs';

const srs = readFileSync('SRS.md', 'utf8').split('\n');
// Deterministic output: derive the label from the SRS version, never from the clock (CI diffs the file).
const srsVersion =
  srs.find((l) => /^\| Version \|/.test(l))?.match(/\|\s*Version\s*\|\s*([0-9][0-9.]*)/)?.[1] ?? 'unknown';

// ---- phase mapping ---------------------------------------------------------------------------------------------------
// FR ids default to the phase written in their section heading; these are the reviewed exceptions.
const FR_OVERRIDE = {
  'FR-PRJ-06': 'Backlog',
  'FR-BLD-09': 'Backlog',
  'FR-PUB-07': 'Backlog',
  'FR-AI-12': 'Backlog',
  'FR-DOM-01': 'P1',
  'FR-DOM-10': 'Removed',
  'FR-WS-05': 'P8',
  'FR-SEO-04': 'P4',
  'FR-SEO-05': 'P8',
  'FR-ABU-01': 'P3',
  'FR-ABU-02': 'P3',
  'FR-ABU-03': 'P8',
  'FR-INT-03': 'P7A',
  'FR-OBS-01': 'P1',
  'FR-TPL-10': 'P2',
};
const NFR_PHASE = {
  'NFR-PERF-01': 'P2',
  'NFR-PERF-02': 'P2',
  'NFR-PERF-03': 'P2',
  'NFR-PERF-04': 'P1',
  'NFR-PERF-05': 'P4',
  'NFR-AVAIL-01': 'P8',
  'NFR-AVAIL-02': 'P8',
  'NFR-DR-01': 'P8',
  'NFR-SCALE-01': 'P8',
  'NFR-SCALE-02': 'P8',
  'NFR-A11Y-01': 'P2',
  'NFR-I18N-01': 'P5',
  'NFR-BROW-01': 'P2',
  'NFR-MAINT-01': 'P0',
  'NFR-OPS-01': 'P0',
  'NFR-COST-01': 'P4',
};
const SEC_PHASE = {
  'SEC-01': 'P1',
  'SEC-02': 'P1',
  'SEC-03': 'P1',
  'SEC-04': 'P2',
  'SEC-05': 'P7A',
  'SEC-06': 'P6',
  'SEC-07': 'P3',
  'SEC-08': 'P3',
  'SEC-09': 'P3',
  'SEC-10': 'P1',
  'SEC-11': 'P5',
  'SEC-12': 'P7A',
  'SEC-13': 'P0',
  'SEC-14': 'P8',
  'SEC-15': 'P8',
  'SEC-16': 'P6',
  'SEC-17': 'P8',
  'SEC-18': 'P0',
  'SEC-19': 'P3',
  'SEC-20': 'P8',
  'SEC-21': 'P0',
};
// What Phase 0 actually did, for the initial status column (kept deliberately small and honest).
const STATUS_P0 = {
  'NFR-OPS-01': 'Done in P0 (clean install, dev, build verified locally)',
  'NFR-MAINT-01': 'Partial in P0 (strict TS + lint; coverage gates start when code exists)',
  'SEC-13':
    'Partial in P0 (lockfile, install scripts denied by default, CI config written, Dependabot config; scanners not run in CI yet)',
  'SEC-18': 'Partial in P0 (threat model v1 written; pen test is P8)',
  'SEC-21': 'Partial in P0 (ADR-013 + privacy inventory; provider regions not all verified)',
  'SEC-04': 'Partial in P0 (lint rule active; renderer arrives in P2)',
  'SEC-03': 'Partial in P0 (separate apps + baseline headers; CSP with real pages later)',
  'SEC-01': 'De-risked in P0 (Spike B); implementation in P1',
  'SEC-02': 'De-risked in P0 (Spike B suite); merge gate in P1',
};

// What Phases 1 and 2 delivered, from their audit reports (PHASE_1_REPORT.md section 1.1, PHASE_2_REPORT.md section 2).
// "Implemented" = code + automated tests; "phase approved" = the Owner approved the phase (with conditions). A later
// phase's status wins over an earlier one for the same id.
const P1 = 'Implemented, phase approved (P1; PHASE_1_REPORT.md)';
const P2 = 'Implemented, phase approved (P2; PHASE_2_REPORT.md)';
const STATUS_DELIVERED = {
  ...Object.fromEntries(
    [
      'FR-AUTH-01',
      'FR-AUTH-02',
      'FR-AUTH-04',
      'FR-AUTH-05',
      'FR-AUTH-06',
      'FR-AUTH-07',
      'FR-AUTH-08',
      'FR-WS-01',
      'FR-WS-02',
      'FR-WS-03',
      'FR-WS-04',
      'FR-PRJ-02',
      'FR-PRJ-03',
      'FR-PRJ-04',
      'FR-PRJ-05',
      'FR-DOM-01',
      'FR-ADM-02',
      'FR-AUD-01',
      'SEC-01',
      'SEC-02',
      'SEC-10',
    ].map((id) => [id, P1]),
  ),
  'FR-AUTH-03': `${P1}; payout/white-label enforcement call sites in P6/P7A`,
  'FR-PRJ-01': `${P1}; the template part landed in P2, project-from-template in P3`,
  'FR-ADM-01': `${P1}: basic console; full console in P8`,
  'FR-NOT-01': `${P1}; real e-mail sending needs a sending domain (DG-10)`,
  'FR-OBS-01':
    'Partial (P1: redacting logger, correlation ids, Sentry live); metrics, tracing, uptime and runbooks moved to P8 by Owner decision',
  'SEC-03':
    'Implemented, phase approved (P1 headers and host CSP; P2 hash-based CSP on rendered sites); builder surfaces in P3',
  'NFR-PERF-04': 'Partial: met on a hosted runner (P1); in-region measurement is P3 S0 (DG-27, DG-28)',
  ...Object.fromEntries(
    [
      'FR-TPL-01',
      'FR-TPL-02',
      'FR-TPL-03',
      'FR-TPL-05',
      'FR-TPL-06',
      'FR-TPL-07',
      'FR-TPL-08',
      'FR-TPL-09',
      'FR-TPL-11',
      'FR-SEO-01',
      'FR-SEO-03',
      'SEC-04',
      'NFR-PERF-03',
    ].map((id) => [id, P2]),
  ),
  'FR-TPL-04': `${P2}; CSS variables per site with a static stylesheet instead of a Tailwind mapping (Owner acknowledged; user design controls are the P3 theme editor)`,
  'FR-TPL-10': `${P2}: 3 reference templates within the Lighthouse budgets; at least 10 by launch`,
  'FR-SEO-02': `${P2}; validation in preflight arrives with publishing (P3)`,
  'NFR-PERF-01':
    'Partial: lab LCP 1.2 to 1.4 s on the three templates (P2); field p75 needs real traffic (condition C4)',
  'NFR-PERF-02': 'Planned: needs the versioned edge cache of published sites (P3, condition C4)',
  'NFR-A11Y-01': `${P2}: axe on every template, block variant and band colour and on the dashboard; Owner acceptance test done; screen-reader pass on real devices still open`,
  'NFR-BROW-01': `${P2}: Chromium, Firefox and WebKit in CI; real Safari and iOS devices are a manual check`,
};

const headingPhase = (line) => {
  // e.g. "### 6.3 Projects (PRJ) – P1, extended P3/P5"  ->  P1
  const m = line.match(/^###\s+6\.\d+\s.*?[–-]\s*(P\d+[AB]?)/);
  return m ? m[1] : null;
};

const rows = [];
let section = null;
let sectionPhase = null;
for (const line of srs) {
  if (/^###\s+6\.\d+\s/.test(line)) {
    section = line.replace(/^###\s+/, '');
    sectionPhase = headingPhase(line);
    continue;
  }
  if (/^##\s/.test(line) && !/^###/.test(line)) sectionPhase = null;
  const cells = line.split('|').map((c) => c.trim());
  const id = cells[1];
  if (!id) continue;
  if (/^FR-[A-Z]+-\d+$/.test(id)) {
    const pri = cells[2] ?? '';
    // table with an explicit Phase column (6.16): FR-ADM/AUD/NOT/OBS rows have 4 data cells
    const explicitPhase =
      cells.length >= 6 && /^P\d/.test(cells[4] ?? '') ? cells[4].match(/^P\d+[AB]?/)[0] : null;
    const phase = FR_OVERRIDE[id] ?? explicitPhase ?? sectionPhase;
    rows.push({ id, pri, phase, text: (cells[3] ?? '').replace(/\*\*/g, '').slice(0, 110), section });
  } else if (/^NFR-[A-Z0-9]+-\d+$/.test(id)) {
    rows.push({
      id,
      pri: 'M',
      phase: NFR_PHASE[id] ?? null,
      text: `${cells[2] ?? ''}: ${cells[3] ?? ''}`.replace(/\*\*/g, '').slice(0, 110),
      section: 'NFR',
    });
  } else if (/^SEC-\d+$/.test(id)) {
    rows.push({
      id,
      pri: 'M',
      phase: SEC_PHASE[id] ?? null,
      text: (cells[2] ?? '').replace(/\*\*/g, '').slice(0, 110),
      section: 'Security',
    });
  }
}

// ---- validation ------------------------------------------------------------------------------------------------------
const errors = [];
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.id)) errors.push(`duplicate id in SRS: ${r.id}`);
  seen.add(r.id);
  if (!r.phase) errors.push(`no phase for ${r.id}`);
}
for (const id of [...Object.keys(FR_OVERRIDE), ...Object.keys(NFR_PHASE), ...Object.keys(SEC_PHASE)]) {
  if (!seen.has(id)) errors.push(`mapping refers to ${id}, which is not in the SRS`);
}
if (errors.length) {
  console.error('traceability generation FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}

// ---- output ----------------------------------------------------------------------------------------------------------
const ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7A', 'P7B', 'P8', 'Backlog', 'Removed'];
const byPhase = Object.fromEntries(ORDER.map((p) => [p, rows.filter((r) => r.phase === p)]));
const kind = (id) => id.split('-')[0];
const counts = (list) =>
  `${list.length} (FR ${list.filter((r) => kind(r.id) === 'FR').length}, NFR ${list.filter((r) => kind(r.id) === 'NFR').length}, SEC ${list.filter((r) => kind(r.id) === 'SEC').length})`;

let md = `# Requirement Traceability Matrix\n\n`;
md += `> GENERATED by \`pnpm traceability\` from SRS.md v${srsVersion}. Do not edit by hand: change the SRS or the mapping in \`scripts/generate-traceability.mjs\`.\n`;
md += `> Coverage: **${rows.length} requirements**, every one mapped to a phase (the script fails otherwise). "Status" comes from the phase reports (P0 to P2); Planned means not started.\n\n`;
md += `| Phase | Requirements |\n|---|---|\n`;
for (const p of ORDER) if (byPhase[p].length) md += `| ${p} | ${counts(byPhase[p])} |\n`;
md += `\n`;
for (const p of ORDER) {
  const list = byPhase[p];
  if (!list.length) continue;
  md += `## ${p}\n\n| ID | Pri | Requirement | Status |\n|---|---|---|---|\n`;
  for (const r of list)
    md += `| ${r.id} | ${r.pri} | ${r.text.replace(/\|/g, '/')} | ${p === 'Removed' ? 'Removed from scope' : (STATUS_DELIVERED[r.id] ?? STATUS_P0[r.id] ?? (p === 'Backlog' ? 'Backlog (COULD)' : 'Planned'))} |\n`;
  md += `\n`;
}
writeFileSync('docs/traceability.md', md);
console.log(
  `traceability: ${rows.length} requirements mapped\n` +
    ORDER.filter((p) => byPhase[p].length)
      .map((p) => `  ${p}: ${counts(byPhase[p])}`)
      .join('\n'),
);
