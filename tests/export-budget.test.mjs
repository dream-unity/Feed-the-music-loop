import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, DEFAULT_MIX, measureMetadata, MAX_PROJECT_NODES, MAX_AUTOMATION_EVENTS } from '../src/project.mjs';
import { exportProject, inspectProjectArchive, validateJsonTree, MAX_MANIFEST_NODES, MAX_MANIFEST_BYTES } from '../src/export/archive.mjs';

const storage = { async listAssets() { return []; } };
test('valid dense arrangement metadata exceeds the old archive node cap and still round-trips', async () => {
  const project = createProject('Dense automation');
  project.events = Array.from({ length: 18000 }, (_, frame) => ({ type: 'mix', frame, id: 'beat', mix: { ...DEFAULT_MIX } }));
  const cost = measureMetadata(project);
  assert.ok(cost.nodes > 250000 && cost.nodes < MAX_PROJECT_NODES);
  const { blob } = await exportProject(storage, project);
  const info = await inspectProjectArchive(blob);
  assert.equal(info.name, project.name); assert.equal(info.assetCount, 0);
  assert.ok(blob.size < MAX_MANIFEST_BYTES);
});

test('archive event lists match project lists and retain a bounded manifest envelope', async () => {
  const project = createProject('Long sparse automation');
  project.events = Array.from({ length: 100001 }, (_, frame) => ({ type: 'mix', frame }));
  const { blob } = await exportProject(storage, project);
  assert.equal((await inspectProjectArchive(blob)).name, project.name);
  assert.ok(MAX_MANIFEST_NODES > MAX_PROJECT_NODES);
  assert.doesNotThrow(() => validateJsonTree(Array(MAX_AUTOMATION_EVENTS).fill(0)));
  assert.throws(() => validateJsonTree(Array(MAX_AUTOMATION_EVENTS + 1).fill(0)), /oversized list/);
});
