// Structural CSS test: the voice selection tray must follow the same
// hidden-by-default / reveal-on-hover-and-focus interaction as its sibling
// help and error trays (live defect: the tray was always visible).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function ruleBody(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} rule exists`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Full rule text (complete selector list + body) of the rule containing `anchor`. */
function ruleAround(anchor) {
  const anchorIndex = css.indexOf(anchor);
  assert.ok(anchorIndex >= 0, `a rule containing ${anchor} exists`);
  const open = css.indexOf('{', anchorIndex);
  const close = css.indexOf('}', open);
  const start = css.lastIndexOf('}', anchorIndex) + 1;
  return css.slice(start, close + 1).trim();
}

test('the voice selection tray is hidden by default like the sibling trays', () => {
  const body = ruleBody('#command-dock .gev-voice-selection {');
  assert.match(body, /visibility:\s*hidden/);
  assert.match(body, /opacity:\s*0/);
  assert.match(body, /pointer-events:\s*none/);
  assert.match(
    body,
    /transform:\s*translateY\([^)]*\)\s*scale\(/,
    'hidden tray sits slightly off its revealed position',
  );
});

test('the voice selection tray reveals on control hover, mic focus, and focus-within', () => {
  const rule = ruleAround('.gev-voice-selection:focus-within');
  assert.match(
    rule,
    /#gev-voice-control:not\(\[data-status='error'\]\):hover \.gev-voice-selection/,
  );
  assert.match(
    rule,
    /:has\(#gev-voice-button:focus-visible\)/,
    'mic-button focus reveals the tray (the button precedes the tray in DOM, so :has() is required)',
  );
  assert.match(rule, /\.gev-voice-selection:focus-within/);
  const body = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'));
  assert.match(body, /visibility:\s*visible/);
  assert.match(body, /opacity:\s*1/);
  assert.match(body, /pointer-events:\s*auto/);
});

test('the voice selection tray transitions with the same timing as the help tray', () => {
  const body = ruleBody('#command-dock .gev-voice-selection {');
  assert.match(
    body,
    /opacity\s+160ms\s+ease,\s*visibility\s+160ms\s+ease,\s*transform\s+210ms\s+cubic-bezier\(\s*0\.2,\s*0\.8,\s*0\.2,\s*1\s*\)/,
  );
});
