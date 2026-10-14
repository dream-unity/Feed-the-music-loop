import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, validateProject, measureMetadata, CaptureMetadataBudget, ProjectHistory,
  MAX_PROJECT_NODES, MAX_PROJECT_BYTES, MAX_AUTOMATION_EVENTS, CAPTURE_RESERVE_NODES, CAPTURE_RESERVE_BYTES,
} from '../src/project.mjs';

test('metadata cost counts JSON nodes and UTF-8 bytes, including multibyte names', () => {
  const value = { name: '声🎤', events: [{ frame: 7, type: 'mix' }] };
  assert.deepEqual(measureMetadata(value), { nodes: 6, bytes: Buffer.byteLength(JSON.stringify(value)) });
  assert.ok(measureMetadata(value).bytes > JSON.stringify(value).length);
});

test('project metadata has independent byte, node and global list limits', () => {
  const project = createProject();
  project.notes = Array.from({ length: 130 }, () => '声'.repeat(33000));
  assert.throws(() => validateProject(project), /12 MiB/);
  delete project.notes;
  project.extras = Array(MAX_AUTOMATION_EVENTS + 1).fill(0);
  assert.throws(() => validateProject(project), /oversized list/);
  project.extras = Array.from({ length: 5 }, () => Array(MAX_AUTOMATION_EVENTS).fill(0));
  assert.throws(() => validateProject(project), /too large/);
});

test('capture budget accounts accepted events incrementally and reserves final metadata', () => {
  const project = createProject(), budget = new CaptureMetadataBudget(project);
  const event = { frame: 120, type: 'mix', id: 'beat', mix: { volume: .7 } };
  const base = measureMetadata(project), cost = measureMetadata(event);
  assert.equal(budget.append(event, 0), true);
  assert.deepEqual({ nodes: budget.nodes, bytes: budget.bytes }, { nodes: base.nodes + cost.nodes, bytes: base.bytes + cost.bytes + 1 });
  project.events.push(event); budget.reconcile(project);
  assert.deepEqual({ nodes: budget.nodes, bytes: budget.bytes }, measureMetadata(project));
  const original = { nodes: budget.nodes, bytes: budget.bytes };
  assert.equal(budget.append(event, MAX_AUTOMATION_EVENTS), false);
  assert.deepEqual({ nodes: budget.nodes, bytes: budget.bytes }, original);
  budget.nodes = MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES - cost.nodes;
  assert.equal(budget.append(event, 1), true);
  assert.equal(budget.hasRoom(), false);
  assert.equal(budget.append(event, 2), false);
  budget.nodes = original.nodes;
  budget.bytes = MAX_PROJECT_BYTES - CAPTURE_RESERVE_BYTES - cost.bytes - 1;
  assert.equal(budget.append(event, 1), true);
  assert.equal(budget.hasRoom(), false);
  assert.equal(budget.append(event, 2), false);
});

test('history bounds combined completed arrangement copies while retaining undo and redo', () => {
  const project = createProject('A'); project.notes = 'x'.repeat(1000);
  const one = measureMetadata(project).bytes, history = new ProjectHistory(40, one * 2 + 20);
  for (const name of ['A', 'B', 'C']) { project.name = name; history.push(project); }
  assert.deepEqual(history.past.map(p => p.name), ['B', 'C']);
  project.name = 'D';
  let current = history.undo(project); assert.equal(current.name, 'C');
  current = history.undo(current); assert.equal(current.name, 'B');
  assert.equal(history.past.length + history.future.length, 2);
  current = history.redo(current); assert.equal(current.name, 'C');
  current = history.redo(current); assert.equal(current.name, 'D');
  assert.equal(history.past.length + history.future.length, 2);
  const tiny = new ProjectHistory(40, 1); tiny.push(project); tiny.push(project);
  assert.equal(tiny.past.length, 1, 'even a project larger than the history budget remains undoable once');
});

test('incomplete arrangement flags and recovered boundaries cannot assert false exactness', () => {
  const project = createProject();
  project.pendingCapture = { arrangementIncomplete: true, arrangementThroughFrame: 4294967300 };
  assert.equal(validateProject(project).pendingCapture.arrangementThroughFrame, 4294967300);
  project.pendingCapture.arrangementThroughFrame = NaN;
  assert.throws(() => validateProject(project), /non-finite|boundary/);
  project.pendingCapture = { arrangementIncomplete: 'yes' };
  assert.throws(() => validateProject(project), /true or false/);
  delete project.pendingCapture;
  project.performances.push({ id: 'perf', name: 'Partial arrangement', leadAssetId: 'raw', masterAssetId: 'master', frames: 1000, startFrame: 100, endFrame: 1100, status: 'complete', arrangementIncomplete: true, editableFrames: 50, events: [] });
  assert.throws(() => validateProject(project), /incomplete arrangement/);
  project.performances[0].status = 'interrupted';
  assert.equal(validateProject(project).performances[0].editableFrames, 50);
  project.performances[0].editableFrames = 1001;
  assert.throws(() => validateProject(project), /editable performance length/);
});
