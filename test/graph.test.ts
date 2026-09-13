import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo } from '../scripts/lib/repo.ts';
import { RefIndex } from '../scripts/lib/render.ts';
import { graphFigure } from '../scripts/lib/graph.ts';

const GREEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'green');
const figure = (): ReturnType<typeof graphFigure> => {
  const repo = loadRepo(GREEN);
  return graphFigure(repo, new RefIndex(repo));
};

const MP2 = 'c38a85eb-1a37-416d-ab21-7ddcc599754d';
const COLLECTION = '2f3de2bb-0588-4513-bfc3-41d021815a81';
const UNIT = '50e8081d-3319-4cd5-8edb-a26cb6bd8078';
const ACCESS = '7a1e2c3d-4b5f-4a6e-9c8d-1f2e3d4c5b6a';

interface Rect { x: number; y: number }
function rects(svg: string): Rect[] {
  return [...svg.matchAll(/<rect class="g-node[^"]*" x="([\d.]+)" y="([\d.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}

test('every entry is a node, every node links to its entry page, and nothing overlaps', () => {
  const { svg, nodeCount } = figure();
  assert.equal(nodeCount, 8);
  const boxes = rects(svg);
  assert.equal(boxes.length, 8);
  assert.equal(new Set(boxes.map((b) => `${b.x},${b.y}`)).size, boxes.length, 'no two nodes share a position');
  assert.match(svg, new RegExp(`<a href="/def/${MP2}"><title>Maximum allowable pressure — SingleValuedDataElement</title>`));
  assert.ok(!/<script/i.test(svg));
});

test('nodes sit in kind columns, and a superseded entry is drawn as such', () => {
  const { svg } = figure();
  const columnX = (uuid: string): number => Number(new RegExp(`<a href="/def/${uuid}">.*?<rect class="g-node[^"]*" x="([\\d.]+)"`, 's').exec(svg)![1]);
  assert.ok(columnX(COLLECTION) < columnX(MP2), 'collections precede elements');
  assert.ok(columnX(MP2) < columnX(UNIT), 'elements precede units');
  assert.match(svg, /class="g-node g-value"/);
  assert.match(svg, /class="g-node g-element g-dead"/); // maxPressure v1
});

test('the reference edges the tree omits are drawn, each in its own style', () => {
  const { svg, edgeCount } = figure();
  assert.ok(edgeCount >= 4);
  // unit and accessCategory are exactly the cross-links /tree cannot show
  assert.match(svg, new RegExp(`stroke="var\\(--chip-unit-fg\\)" stroke-dasharray="4 3"`));
  assert.match(svg, new RegExp(`stroke="var\\(--chip-tier-fg\\)"`));
  assert.match(svg, /stroke="var\(--dead-edge\)" stroke-dasharray="6 3"/); // replaces
  // every path starts and ends on a node's left or right face, vertically centred
  const faces = new Set(rects(svg).flatMap(({ x, y }) => [`${x},${y + 11}`, `${x + 208},${y + 11}`]));
  const ends = [...svg.matchAll(/d="M ([\d.-]+) ([\d.-]+) C [^"]*, ([\d.-]+) ([\d.-]+)"/g)];
  assert.ok(ends.length > 0);
  for (const [, x1, y1, x2, y2] of ends) {
    assert.ok(faces.has(`${Number(x1)},${Number(y1)}`), `edge starts off-node at ${x1},${y1}`);
    assert.ok(faces.has(`${Number(x2)},${Number(y2)}`), `edge ends off-node at ${x2},${y2}`);
  }
});

test('the figure is repeated as text, so the graph is never SVG-only', () => {
  const { edgeList, edgeCount } = figure();
  assert.equal((edgeList.match(/<tr><td><a href="\/def\//g) ?? []).length, edgeCount);
  assert.match(edgeList, new RegExp(`<a href="/def/${COLLECTION}">Mechanical properties</a></td><td><code>member</code>`));
  assert.match(edgeList, new RegExp(`<code>accessCategory</code></td><td><a href="/def/${ACCESS}">Authority only</a>`));
});

test('layout is deterministic — two runs are byte-identical', () => {
  assert.equal(figure().svg, figure().svg);
});
